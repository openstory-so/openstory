/**
 * Voice input server function: transcribes a browser recording so it can be
 * dropped into a script or prompt editor.
 *
 * The client imports this file for its RPC stub, so only handler bodies may
 * reference server-heavy modules (`@/lib/audio/voice-transcription` pulls in
 * `@tanstack/ai-fal`); the module-level schema reads its limits from the
 * client-safe `@/lib/voice/voice-limits` (#1257).
 */

import {
  baseMimeType,
  decodeBase64Audio,
  transcribeVoiceAudio,
  VOICE_TRANSCRIPTION_MODEL,
} from '@/lib/audio/voice-transcription';
import { RateLimiter } from '@/lib/ai/script-enhancer';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { InsufficientCreditsError } from '@/lib/errors';
import {
  MAX_VOICE_AUDIO_BASE64_CHARS,
  MAX_VOICE_RECORDING_MS,
} from '@/lib/voice/voice-limits';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

/** Per-IP: a take every two seconds is already faster than anyone dictates. */
const voiceTranscriptionRateLimiter = new RateLimiter(30, 60_000);

function getClientIP(): string {
  const request = getRequest();
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'anonymous'
  );
}

const transcribeVoiceInputSchema = z.object({
  /** Recorded bytes as base64 (no `data:` prefix) — `AudioRecording.base64`. */
  audio: z
    .string()
    .min(1, 'Recording is empty')
    .max(MAX_VOICE_AUDIO_BASE64_CHARS, 'Recording is too large'),
  /** The recorder's native container type, e.g. `audio/webm;codecs=opus`. */
  mimeType: z
    .string()
    .regex(/^audio\/[\w.+-]+(;.*)?$/i, 'Unsupported recording type'),
  durationMs: z
    .number()
    .int()
    .positive()
    // A little slack over the client cap: the recorder's own clock runs from
    // `start()` resolving, not from the auto-stop timer.
    .max(MAX_VOICE_RECORDING_MS + 10_000, 'Recording is too long'),
  /** ISO-639-1 hint; omitted = auto-detect. */
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
});

export type TranscribeVoiceInput = z.infer<typeof transcribeVoiceInputSchema>;

export const transcribeVoiceFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(transcribeVoiceInputSchema))
  .handler(async ({ data, context }) => {
    const ip = getClientIP();
    if (!voiceTranscriptionRateLimiter.isAllowed(ip)) {
      const remainingMs = voiceTranscriptionRateLimiter.getRemainingTime(ip);
      throw new Error(
        `Rate limit exceeded. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`
      );
    }

    const { scopedDb } = context;

    // Same shape as `prepareBilling` for LLM calls: a team on its own fal key
    // pays fal directly; everyone else is gated on the small-call estimate
    // and charged the exact fal-reported cost afterwards.
    const falKey = await scopedDb.apiKeys.resolveKey('fal');
    const billed = falKey.source !== 'team';
    if (billed) {
      const canAfford = await scopedDb.billing.hasEnoughCredits(
        estimateLLMCost(1)
      );
      if (!canAfford) {
        throw new InsufficientCreditsError(
          'Insufficient credits for voice transcription'
        );
      }
    }

    const audio = new Blob([decodeBase64Audio(data.audio)], {
      type: baseMimeType(data.mimeType),
    });

    const result = await transcribeVoiceAudio({
      audio,
      apiKey: falKey.key,
      ...(data.language ? { language: data.language } : {}),
    });

    if (billed) {
      const description = `Voice transcription (${VOICE_TRANSCRIPTION_MODEL})`;
      const metadata = {
        model: VOICE_TRANSCRIPTION_MODEL,
        durationMs: data.durationMs,
        unitsBilled: result.unitsBilled,
        requestId: result.requestId,
      };
      if (result.cost > 0) {
        await scopedDb.billing.deductCredits(result.cost, {
          description,
          metadata,
        });
      } else {
        reportMissingBillingCost({
          source: 'server-fn-deduct',
          modelId: VOICE_TRANSCRIPTION_MODEL,
          description,
          metadata,
        });
      }
    }

    return {
      text: result.text,
      language: result.language ?? null,
    };
  });
