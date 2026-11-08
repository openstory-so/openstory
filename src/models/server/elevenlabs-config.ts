/**
 * ElevenLabs env — native TTS, Voice Design, and Music (#1552 / #1640).
 *
 * Platform key only: `API_KEY_PROVIDERS` has no `'elevenlabs'`. Designed
 * voices live in the account that created them, so an organization key would not see
 * voices we design (same shape as `ARK_API_KEY`). Workflows spend the key
 * through `scopedDb.credentials.resolveKey('elevenlabs')`, which reads this
 * module rather than `organization_api_keys`.
 */

import { getEnv } from '#env';
import { optionalEnv } from '@/platform/server/env/environment';
import { workersSafeFetch } from '@/platform/server/ai/workers-safe-fetch';
import type { ElevenLabsClientConfig } from '@tanstack/ai-elevenlabs';

/** The platform ElevenLabs key, or undefined when it is not configured. */
export function getElevenLabsApiKey(): string | undefined {
  return optionalEnv('ELEVENLABS_API_KEY');
}

function getElevenLabsBaseUrl(): string | undefined {
  return optionalEnv('ELEVENLABS_BASE_URL');
}

/**
 * True when the platform can call ElevenLabs at all.
 *
 * Playwright injects the developer's process env into the worker
 * (`CLOUDFLARE_INCLUDE_PROCESS_ENV`), so an `ELEVENLABS_API_KEY` sitting in
 * a local `.env.local` would silently point the suite at real, billable
 * ElevenLabs. Under `E2E_TEST` the via therefore stays off unless
 * `ELEVENLABS_BASE_URL` is also set — i.e. unless someone has deliberately
 * wired a mock host to record against. Replay always sets both.
 */
export function isElevenLabsConfigured(): boolean {
  if (getElevenLabsApiKey() === undefined) return false;
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !getElevenLabsBaseUrl()) return false;
  return true;
}

/** 429 is the account's concurrency cap (#2295); a 429 never ran, so it is safe to resend. */
const RATE_LIMIT_RETRIES = 8;

function rateLimitDelayMs(headers: Headers, attempt: number) {
  const retryAfter = Number(headers.get('retry-after'));
  const ms =
    retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** attempt * (1 + Math.random() * 0.2);
  return Math.min(ms, 60_000);
}

function sleep(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function rateLimitHeaders(error: unknown): Headers | undefined {
  if (
    error instanceof Object &&
    'statusCode' in error &&
    error.statusCode === 429
  ) {
    const raw = 'rawResponse' in error ? error.rawResponse : undefined;
    return raw instanceof Object &&
      'headers' in raw &&
      raw.headers instanceof Headers
      ? raw.headers
      : new Headers();
  }
  return undefined;
}

/**
 * The only retry on an ElevenLabs call: re-runs it after a 429, each attempt
 * under its own timeout. Clients are built with `maxRetries: 0`.
 */
export async function retryOnRateLimit<T>(
  call: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const headers = rateLimitHeaders(error);
      if (!headers || attempt >= RATE_LIMIT_RETRIES) throw error;
      await sleep(rateLimitDelayMs(headers, attempt), signal);
    }
  }
}

/**
 * Shared adapter / SDK config. `timeoutInSeconds` is the SDK's stall
 * deadline so a hung TTS / music call fails the workflow step instead of
 * hanging it (the same guarantee `createDeadlineFetch` gives the fal path).
 */
export function elevenLabsAdapterConfig(
  apiKey: string,
  timeoutInSeconds = 60
): ElevenLabsClientConfig {
  const baseURL = getElevenLabsBaseUrl();
  return {
    apiKey,
    timeoutInSeconds,
    maxRetries: 0,
    ...(baseURL && { baseURL }),
  };
}

/**
 * Lazy-load the TTS adapter. A static import of `@tanstack/ai-elevenlabs`
 * from a workflow graph in `src/server.ts` is the same startup-CPU trap
 * BytePlus hit with `@tanstack/ai-byteplus`.
 */
export async function loadElevenLabsSpeech() {
  const { createElevenLabsSpeech } = await import('@tanstack/ai-elevenlabs');
  return createElevenLabsSpeech;
}

/**
 * Lazy-load the music / SFX adapter. Same startup-CPU reason as speech:
 * a static import of `@tanstack/ai-elevenlabs` from a workflow graph in
 * `src/server.ts` would pull the SDK into every Worker isolate boot.
 */
export async function loadElevenLabsAudio() {
  const { createElevenLabsAudio } = await import('@tanstack/ai-elevenlabs');
  return createElevenLabsAudio;
}

/**
 * Lazy-load the Voice Design adapter (`@tanstack/ai-elevenlabs` >=0.6, #1640).
 * Same startup-CPU reason as speech/audio. Covers preview generation
 * (`textToVoice.design`) only — it has no standalone "save this preview" or
 * voice-management surface, so `createElevenLabsSdk` below still backs
 * `saveDesignedVoice` / `deleteElevenLabsVoice` / list / share.
 */
export async function loadElevenLabsVoiceDesign() {
  const { createElevenLabsVoiceDesign } =
    await import('@tanstack/ai-elevenlabs');
  return createElevenLabsVoiceDesign;
}

/**
 * Official SDK client for voice management — save / delete / get / list /
 * share, none of which the `@tanstack/ai-elevenlabs` adapters expose.
 * `fetch` is the workerd-safe global so a method-extracted `this.fetch`
 * cannot throw Illegal invocation.
 */
export async function createElevenLabsSdk(
  apiKey: string,
  timeoutInSeconds = 60
) {
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  const config = elevenLabsAdapterConfig(apiKey, timeoutInSeconds);
  return new ElevenLabsClient({
    apiKey: config.apiKey,
    timeoutInSeconds: config.timeoutInSeconds,
    maxRetries: config.maxRetries,
    fetch: workersSafeFetch,
    ...(config.baseURL && { baseUrl: config.baseURL }),
  });
}
