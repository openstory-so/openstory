/**
 * ElevenLabs env — native TTS and Voice Design (#1552).
 *
 * Platform key only: `API_KEY_PROVIDERS` has no `'elevenlabs'`. Designed
 * voices live in the account that created them, so a team key would not see
 * voices we design (same shape as `ARK_API_KEY`). Workflows spend the key
 * through `scopedDb.credentials.resolveKey('elevenlabs')`, which reads this
 * module rather than `team_api_keys`.
 */

import { getEnv } from '#env';
import { workersSafeFetch } from '@/platform/server/ai/workers-safe-fetch';
import type { ElevenLabsClientConfig } from '@tanstack/ai-elevenlabs';

function optionalEnv(name: string): string | undefined {
  const value = Reflect.get(getEnv(), name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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

/**
 * Shared adapter / SDK config. `timeoutInSeconds` is the SDK's stall
 * deadline so a hung TTS call fails the workflow step instead of hanging
 * it (the same guarantee `createDeadlineFetch` gives the fal path).
 */
export function elevenLabsAdapterConfig(
  apiKey: string,
  timeoutInSeconds = 60
): ElevenLabsClientConfig {
  const baseURL = getElevenLabsBaseUrl();
  return {
    apiKey,
    timeoutInSeconds,
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
 * Official SDK client for Voice Design / create-voice — endpoints
 * `elevenlabsSpeech` does not wrap. `fetch` is the workerd-safe global so
 * a method-extracted `this.fetch` cannot throw Illegal invocation.
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
    fetch: workersSafeFetch,
    ...(config.baseURL && { baseUrl: config.baseURL }),
  });
}
