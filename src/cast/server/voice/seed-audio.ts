/**
 * Seed Audio 1.0 on BytePlus Seed Speech (#1765) — one non-streaming call:
 * a text prompt, up to three reference clips (`@Audio1`…), one WAV back.
 *
 * Every take is transcribed and each line found in what was heard
 * (`take-check.ts`); the transcription's word timings are what a take is
 * split and trimmed by. Not Seed's own subtitles: they run adjacent lines
 * together into one timed word, so a line break inside a take is lost
 * (#1803: off by up to 2.3 s).
 *
 * Limits (all seen in testing): 3 references, each ≤ 30 s and ≤ 10 MB; 120 s
 * of audio; a 3,000-character prompt; a per-account QPS cap, paced by the
 * BytePlus governor. Billing is `original_duration`, trailing silence
 * included.
 */

import type { Microdollars } from '@/billing/money';
import {
  SEED_AUDIO_ENDPOINT,
  seedAudioCost,
} from '@/billing/seed-speech-pricing';
import { SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import type { GatewayJobInput } from '@/gateway/schema';
import { acquireSeedSpeechToken } from '@/models/server/byteplus-governor';
import { getSeedSpeechBaseUrl } from '@/models/server/seed-speech-config';
import { gatewayRunRoute } from '@/gateway/server/route';
import { SEED_AUDIO_TARGET } from '@/audio/gateway-targets';
import {
  runAudioOnGateway,
  type AudioGatewayCall,
  type AudioRun,
} from '@/audio/server/audio-gateway';
import { base64ToBytes, bytesToBase64 } from '@/platform/base64';
import { generateId } from '@/platform/id';
import { r2KeyFromUrl } from '@/platform/server/storage/buckets';
import { honestDataSize } from '@/motion/server/pad-dialogue-audio';
import { readStorageObject } from '#storage';
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
  /** Seconds the caller bills (`original_duration`); null when the gateway held and charged the take. */
  billedSeconds: number | null;
};

/** Records one take of a Seed Audio body; `take` numbers the takes of one step. */
export type SeedRecorder = (
  body: GatewayJobInput,
  take: number
) => Promise<SeedAudioResult>;

/** The caller's ledger line for a take: none when the gateway charged it. */
export function seedCharge(billedSeconds: number | null): {
  endpointId: string;
  model: string;
  costMicros: Microdollars;
}[] {
  return billedSeconds === null
    ? []
    : [
        {
          endpointId: SEED_AUDIO_ENDPOINT,
          model: SEED_AUDIO_MODEL,
          costMicros: seedAudioCost(billedSeconds),
        },
      ];
}

/** The request: a text prompt and the reference clips as bytes, `@Audio1` first. */
function seedAudioBody(
  prompt: string,
  references: readonly Uint8Array[]
): GatewayJobInput {
  return {
    model: SEED_AUDIO_MODEL,
    text_prompt: prompt,
    ...(references.length > 0 && {
      references: references.map((bytes) => ({
        audio_data: bytesToBase64(bytes),
      })),
    }),
    audio_config: { format: 'wav', sample_rate: SAMPLE_RATE },
  };
}

type SeedResponse = {
  code?: number;
  message?: string;
  audio?: string;
  original_duration?: number;
};

/** The platform key, called here; the caller bills `billedSeconds`. */
function platformSeedRecorder(apiKey: string): SeedRecorder {
  return async (input) => {
    const body = JSON.stringify(input);
    for (let attempt = 0; ; attempt++) {
      await acquireSeedSpeechToken();
      const res = await fetch(`${getSeedSpeechBaseUrl()}/api/v3/tts/create`, {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
          'X-Api-Request-Id': generateId(),
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(240_000),
      });
      const json: SeedResponse = await res
        .json<SeedResponse>()
        .catch(() => ({}));
      if (res.status === 429 && attempt < QUOTA_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * (attempt + 1))
        );
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
  };
}

/** The gateway: each take is held and charged there under `${idempotencyKey}:${take}`. */
function gatewaySeedRecorder(call: AudioGatewayCall): SeedRecorder {
  return async (body, take) => {
    const { outputs } = await runAudioOnGateway(
      { ...call, idempotencyKey: `${call.idempotencyKey}:${take}` },
      body
    );
    const url = outputs[0]?.url;
    const key = url ? r2KeyFromUrl(url) : null;
    const stored = key ? await readStorageObject(key) : null;
    if (!stored) throw new Error('The gateway stored no Seed take');
    honestDataSize(stored.bytes);
    return { wav: stored.bytes, billedSeconds: null };
  };
}

/** Each take goes where the run's routes send its body; `idempotencyKey` is the step's, with no attempt, so a retry replays its takes. */
export function seedRecorderFor(params: AudioRun): SeedRecorder {
  const { routes, ...call } = params;
  return async (body, take) => {
    const route = gatewayRunRoute(routes, SEED_AUDIO_TARGET, body);
    if (route.via === 'openstory') {
      return gatewaySeedRecorder({ ...call, model: route.model })(body, take);
    }
    const { key } = await call.scopedDb.credentials.resolveKey('seed-speech');
    return platformSeedRecorder(key)(body, take);
  };
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
  record: SeedRecorder;
  /** Numbers this take among the step's takes. */
  take: number;
  elevenLabsKey: string;
  prompt: string;
  references: readonly Uint8Array[];
  parts: readonly string[];
}): Promise<CheckedTake> {
  const take = await input.record(
    seedAudioBody(input.prompt, input.references),
    input.take
  );
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
