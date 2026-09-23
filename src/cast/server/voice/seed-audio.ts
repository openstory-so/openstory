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
import { decodeBase64 } from '@/motion/server/synthesize-dialogue';
import { generateId } from '@/platform/id';

export const SEED_AUDIO_MAX_REFERENCES = 3;
export const SEED_AUDIO_MAX_PROMPT_CHARS = 3000;

/** What `cutAudioSection` and `trimmedEndSeconds` expect. */
const SAMPLE_RATE = 44_100;
const QUOTA_RETRIES = 6;

/** A booth, said plainly: Seed is a full-scene model with no speech-only switch. */
export const SEED_BOOTH_PROMPT =
  "Voice-over recording in a silent, treated vocal booth. A single close microphone captures only the speaker's voice. There is nothing else in the recording: no music, no ambience, no room tone, no sound effects, no foley.";

export type SeedAudioResult = {
  wav: Uint8Array<ArrayBuffer>;
  /** Seconds billed (`original_duration`). */
  billedSeconds: number;
};

class SeedAudioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined
  ) {
    super(message);
    this.name = 'SeedAudioError';
  }
}

type SeedResponse = {
  code?: number;
  message?: string;
  audio?: string;
  original_duration?: number;
};

export async function seedAudio(input: {
  apiKey: string;
  prompt: string;
  /** Reference clips as bytes, `@Audio1` first. */
  references: readonly Uint8Array[];
}): Promise<SeedAudioResult> {
  if (input.prompt.length > SEED_AUDIO_MAX_PROMPT_CHARS) {
    throw new SeedAudioError(
      `Seed Audio prompt is ${input.prompt.length} characters; the limit is ${SEED_AUDIO_MAX_PROMPT_CHARS}`,
      400,
      undefined
    );
  }
  if (input.references.length > SEED_AUDIO_MAX_REFERENCES) {
    throw new SeedAudioError(
      `Seed Audio takes ${SEED_AUDIO_MAX_REFERENCES} reference clips, not ${input.references.length}`,
      400,
      undefined
    );
  }
  const body = JSON.stringify({
    model: SEED_AUDIO_MODEL,
    text_prompt: input.prompt,
    ...(input.references.length > 0 && {
      references: input.references.map((bytes) => ({
        audio_data: toBase64(bytes),
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
      throw new SeedAudioError(
        `Seed Audio ${res.status}${json.code ? ` ${json.code}` : ''}: ${json.message ?? 'no audio returned'}`,
        res.status,
        json.code
      );
    }
    return {
      wav: decodeBase64(json.audio),
      billedSeconds: json.original_duration ?? 0,
    };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
