/**
 * Voice input: speech-to-text for the script and prompt editors.
 *
 * The browser records with TanStack AI's `AudioRecorder` (`@tanstack/ai-client`)
 * and posts the take to `transcribeVoiceFn`, which runs it through fal Whisper
 * via TanStack AI's `generateTranscription` activity and the `falTranscription`
 * adapter. The fal client uploads the Blob to fal storage itself, so the audio
 * never needs to be hosted by us.
 *
 * Server-only: pulls in `@tanstack/ai-fal` and the fal proxy config. Reference
 * it from server fn handler bodies only (#1257).
 */

import { configureFalProxyFromEnv } from '@/lib/ai/fal-config';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import type { Microdollars } from '@/lib/billing/money';
import { getLogger } from '@/lib/observability/logger';
import { generateTranscription } from '@tanstack/ai';
import { falTranscription } from '@tanstack/ai-fal';

const logger = getLogger(['openstory', 'audio', 'voice-transcription']);

/**
 * fal Whisper (large-v3). Accepts webm/mp4/wav/mp3 — every container the
 * browsers' MediaRecorder produces — and auto-detects the language when none
 * is given. Spec: https://fal.ai/models/fal-ai/whisper/llms.txt
 */
export const VOICE_TRANSCRIPTION_MODEL = 'fal-ai/whisper';

/** A three-minute take transcribes in seconds; this only bounds a hung queue. */
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;

export type TranscribeVoiceOptions = {
  /** The recorded take, typed with its container mime (`audio/webm`, `audio/mp4`…). */
  audio: Blob;
  /** Resolved fal key (team BYOK or platform). */
  apiKey: string;
  /** ISO-639-1 hint. Omit to let Whisper detect the language. */
  language?: string;
};

export type VoiceTranscription = {
  text: string;
  language?: string;
  requestId?: string;
  /** fal-reported billed units, when the response carried them. */
  unitsBilled?: number;
  /** Exact cost from `unitsBilled` × live unit price; $0 when either is missing. */
  cost: Microdollars;
};

/**
 * Whisper emits a single line; tidy stray runs of spaces and trim. Newlines
 * (present with `chunk_level: segment`, absent with `none`) are kept.
 */
export function normalizeTranscript(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * Base64 (no `data:` prefix) → bytes. Runs on Workers and Node alike;
 * `Buffer` is not available in the Worker runtime.
 */
export function decodeBase64Audio(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Strip codec parameters (`audio/webm;codecs=opus` → `audio/webm`). fal
 * storage names the upload from the mime subtype, and Whisper sniffs the
 * container, so the bare type is all that is needed.
 */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'audio/webm';
}

export async function transcribeVoiceAudio(
  options: TranscribeVoiceOptions
): Promise<VoiceTranscription> {
  configureFalProxyFromEnv();
  const startedAt = Date.now();

  const adapter = falTranscription(VOICE_TRANSCRIPTION_MODEL, {
    apiKey: options.apiKey,
  });
  const result = await generateTranscription({
    adapter,
    audio: options.audio,
    ...(options.language ? { language: options.language } : {}),
    // `none` returns one chunk for the whole take: fal's docs recommend it
    // for better transcription quality, and it is slightly faster.
    modelOptions: { chunk_level: 'none' },
    timeout: VOICE_TRANSCRIPTION_TIMEOUT_MS,
    debug: false,
  });

  const cost = await falCostFromUnits(
    VOICE_TRANSCRIPTION_MODEL,
    result.usage?.unitsBilled
  );

  logger.info('Transcribed voice input', {
    model: VOICE_TRANSCRIPTION_MODEL,
    audioBytes: options.audio.size,
    mimeType: options.audio.type,
    durationMs: Date.now() - startedAt,
    chars: result.text.length,
    unitsBilled: result.usage?.unitsBilled,
    cost,
  });

  return {
    text: normalizeTranscript(result.text),
    ...(result.language ? { language: result.language } : {}),
    ...(result.id ? { requestId: result.id } : {}),
    ...(result.usage?.unitsBilled !== undefined
      ? { unitsBilled: result.usage.unitsBilled }
      : {}),
    cost,
  };
}
