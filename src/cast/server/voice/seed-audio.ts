/**
 * Seed Audio 1.0 on BytePlus Seed Speech (#1765) — one non-streaming call:
 * a text prompt, up to three reference clips (`@Audio1`…), one WAV back.
 *
 * Seed sometimes speaks invented words, so every take is transcribed
 * (`take-check.ts`) and the transcription's word timings — not Seed's own
 * subtitles, which only align the script and never show an invented word —
 * are what a take is split and trimmed by.
 *
 * Limits (all seen in testing): 3 references, each ≤ 30 s and ≤ 10 MB; 120 s
 * of audio; a 3,000-character prompt; a per-account QPS cap, paced by the
 * BytePlus governor. Billing is `original_duration`, trailing silence
 * included.
 */

import { SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import { acquireSeedSpeechToken } from '@/models/server/byteplus-governor';
import { getSeedSpeechBaseUrl } from '@/models/server/seed-speech-config';
import { base64ToBytes, bytesToBase64 } from '@/platform/base64';
import { generateId } from '@/platform/id';
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
  /** Seconds billed (`original_duration`). */
  billedSeconds: number;
};

type SeedResponse = {
  code?: number;
  message?: string;
  audio?: string;
  original_duration?: number;
};

async function seedAudio(input: {
  apiKey: string;
  prompt: string;
  /** Reference clips as bytes, `@Audio1` first. */
  references: readonly Uint8Array[];
}): Promise<SeedAudioResult> {
  const body = JSON.stringify({
    model: SEED_AUDIO_MODEL,
    text_prompt: input.prompt,
    ...(input.references.length > 0 && {
      references: input.references.map((bytes) => ({
        audio_data: bytesToBase64(bytes),
      })),
    }),
    audio_config: {
      format: 'wav',
      sample_rate: SAMPLE_RATE,
    },
  });
  for (let attempt = 0; ; attempt++) {
    await acquireSeedSpeechToken();
    const res = await fetch(`${getSeedSpeechBaseUrl()}/api/v3/tts/create`, {
      method: 'POST',
      headers: {
        'X-Api-Key': input.apiKey,
        'X-Api-Request-Id': generateId(),
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(240_000),
    });
    const json: SeedResponse = await res.json<SeedResponse>().catch(() => ({}));
    if (res.status === 429 && attempt < QUOTA_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok || !json.audio) {
      throw new Error(
        `Seed Audio ${res.status}${json.code ? ` ${json.code}` : ''}: ${json.message ?? 'no audio returned'}`
      );
    }
    const wav = base64ToBytes(json.audio);
    honestDataSize(wav);
    return { wav, billedSeconds: json.original_duration ?? 0 };
  }
}

export type CheckedTake = SeedAudioResult & {
  /** Seconds Scribe transcribed, for billing. */
  heardSeconds: number;
  check: PartsCheck;
};

/**
 * One Seed take, transcribed and held against the parts it was asked to say
 * in order. Seed sometimes speaks invented words, so no take is used unchecked.
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
