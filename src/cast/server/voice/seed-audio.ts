/**
 * Seed Audio 1.5 early access (#1765). Voice generation and dialogue share
 * this call: `POST /api/v3/contents/generations`, Bearer auth, a `content`
 * list. A voice range read sends text only. Dialogue adds reference clips
 * in `@Audio1` order, as `data:audio/<format>;base64,…` with role
 * `reference_audio`.
 *
 * The response lists stem URLs. Dialogue and voice reads keep the `speaker`
 * stem and download it in this step. Scribe's word timings split the WAV.
 * Seed's own subtitles are not used: they run adjacent lines together
 * (#1803: off by up to 2.3 s).
 *
 * Early access allows 6 references, each 2–30 s and ≤ 15 MB. We still send
 * at most {@link SEED_AUDIO_MAX_REFERENCES}. Concurrency is 2 per key.
 * Billing reads `usage.final_duration_ms`. Early access itself is free;
 * the stored card is still the 1.0 rate until a bill says otherwise.
 */

import { acquireSeedSpeechToken } from '@/models/server/byteplus-governor';
import {
  getSeedAudioEndpoint,
  getSeedSpeechBaseUrl,
} from '@/models/server/seed-speech-config';
import { base64ToBytes, bytesToBase64 } from '@/platform/base64';
import { honestDataSize } from '@/motion/server/pad-dialogue-audio';
import { transcribeSpeech } from './elevenlabs-voice';
import { checkParts, type PartsCheck } from './take-check';

export const SEED_AUDIO_MAX_REFERENCES = 3;
export const SEED_AUDIO_MAX_PROMPT_CHARS = 3000;

/** What `cutAudioSection` and `trimmedEndSeconds` expect. */
const SAMPLE_RATE = 44_100;
const QUOTA_RETRIES = 6;

/** A booth, said plainly: Seed is a full-scene model with no speech-only switch. */
export const SEED_BOOTH_PROMPT =
  "Voice-over recording in a silent, treated vocal booth. A single close microphone captures only the speaker's voice. There is nothing else in the recording: no music, no ambience, no room tone, no sound effects, no foley.";

type SeedAudioResult = {
  wav: Uint8Array<ArrayBuffer>;
  /** Seconds billed (`usage.final_duration_ms`). */
  billedSeconds: number;
};

type SeedAudioItem = {
  url?: string;
  type?: string;
};

type SeedResponse = {
  code?: number;
  message?: string;
  error?: { message?: string; code?: string };
  content?: { audios?: SeedAudioItem[] };
  usage?: { duration_ms?: number; final_duration_ms?: number };
};

/** Isolated clips are MP3. A WAV is recognised by its RIFF header. */
function referenceDataUrl(bytes: Uint8Array): string {
  const wav =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45;
  return `data:audio/${wav ? 'wav' : 'mp3'};base64,${bytesToBase64(bytes)}`;
}

/** The voice stem. A single untyped file is that stem. Music and effects are not. */
function speakerUrl(json: SeedResponse): string | undefined {
  const audios = json.content?.audios ?? [];
  const speaker = audios.find((audio) => audio.type === 'speaker' && audio.url);
  if (speaker?.url) return speaker.url;
  if (audios.length === 1) return audios[0]?.url;
  return undefined;
}

function seedError(status: number, json: SeedResponse): string {
  const detail =
    json.message ?? json.error?.message ?? 'no speaker audio returned';
  const code = json.code ?? json.error?.code;
  return `Seed Audio ${status}${code ? ` ${code}` : ''}: ${detail}`;
}

async function readReturnedAudio(
  url: string
): Promise<Uint8Array<ArrayBuffer>> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0)
      throw new Error('Seed Audio returned a data URI with no payload');
    const wav = base64ToBytes(url.slice(comma + 1));
    honestDataSize(wav);
    return wav;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Seed Audio file ${res.status}`);
  const wav = new Uint8Array(await res.arrayBuffer());
  honestDataSize(wav);
  return wav;
}

/** One 1.5 take. Voice generation passes no references. */
export async function seedAudio(input: {
  apiKey: string;
  prompt: string;
  /** Reference clips as bytes, `@Audio1` first. */
  references: readonly Uint8Array[];
}): Promise<SeedAudioResult> {
  const body = JSON.stringify({
    model: getSeedAudioEndpoint(),
    content: [
      { type: 'text', text: input.prompt },
      ...input.references.map((bytes) => ({
        type: 'audio_url',
        audio_url: { url: referenceDataUrl(bytes) },
        role: 'reference_audio',
      })),
    ],
    output_format: 'wav',
    audio_config: {
      sample_rate: SAMPLE_RATE,
      speech_rate: 0,
      loudness_rate: 0,
      pitch_rate: 0,
    },
  });
  for (let attempt = 0; ; attempt++) {
    await acquireSeedSpeechToken();
    const res = await fetch(
      `${getSeedSpeechBaseUrl()}/api/v3/contents/generations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(240_000),
      }
    );
    const json: SeedResponse = await res.json<SeedResponse>().catch(() => ({}));
    if (res.status === 429 && attempt < QUOTA_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    const url = res.ok ? speakerUrl(json) : undefined;
    if (!res.ok || !url) throw new Error(seedError(res.status, json));
    const wav = await readReturnedAudio(url);
    const ms = json.usage?.final_duration_ms ?? json.usage?.duration_ms ?? 0;
    return { wav, billedSeconds: ms / 1000 };
  }
}

export type CheckedTake = SeedAudioResult & {
  /** Seconds Scribe transcribed, for billing. */
  heardSeconds: number;
  check: PartsCheck;
};

/**
 * One Seed take, transcribed, with where each of the parts it was asked to
 * say was spoken, in order.
 */
export async function recordCheckedTake(input: {
  seedKey: string;
  elevenLabsKey: string;
  prompt: string;
  references: readonly Uint8Array[];
  parts: readonly string[];
}): Promise<CheckedTake> {
  const take = await seedAudio({
    apiKey: input.seedKey,
    prompt: input.prompt,
    references: input.references,
  });
  const heard = await transcribeSpeech(
    input.elevenLabsKey,
    take.wav,
    'audio/wav'
  );
  return {
    ...take,
    heardSeconds: heard.seconds,
    check: checkParts(heard.words, input.parts),
  };
}
