/** Gateway wire types, shared by the API and the UI (docs/architecture/model-gateway.md). */

import type { MediaVia } from '@/models/via';
import type { JsonValue } from '@/platform/server/db/schema';

/** modelschemas provider ids: the `{provider}` in `/gateway/{provider}/{model}`. */
export const GATEWAY_PROVIDERS = [
  'fal',
  'byteplus',
  'gemini',
  'grok',
  'elevenlabs',
] as const;
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

export function isGatewayProvider(value: string): value is GatewayProvider {
  return GATEWAY_PROVIDERS.some((provider) => provider === value);
}

/** A gateway job's via: a media via, or ElevenLabs, which the product calls outside `MediaVia`. */
export type GatewayVia = MediaVia | 'elevenlabs';

/** The via each provider's jobs are stamped with. */
export const GATEWAY_VIA: Readonly<Record<GatewayProvider, GatewayVia>> = {
  fal: 'fal',
  byteplus: 'byteplus',
  gemini: 'google',
  grok: 'xai',
  elevenlabs: 'elevenlabs',
};

/** The provider a stamped via belongs to. */
export function gatewayProviderOfVia(via: GatewayVia): GatewayProvider {
  const provider = GATEWAY_PROVIDERS.find((p) => GATEWAY_VIA[p] === via);
  if (!provider) throw new Error(`No gateway provider for via ${via}`);
  return provider;
}

/** The BytePlus endpoints the gateway has a driver for; Seed ASR returns text and is not one. */
export const BYTEPLUS_ENDPOINTS = {
  tasks: 'contents/generations/tasks',
  images: 'images/generations',
  speech: 'tts/create',
} as const;

/** The ElevenLabs endpoints the driver calls: the platform key reaches the whole account, voices included. */
export const ELEVENLABS_ENDPOINTS: readonly string[] = ['v1/music'];

export const GATEWAY_JOB_KINDS = ['image', 'video', 'audio'] as const;
export type GatewayJobKind = (typeof GATEWAY_JOB_KINDS)[number];

export const GATEWAY_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
] as const;
export type GatewayJobStatus = (typeof GATEWAY_JOB_STATUSES)[number];

/** The provider's own request body, as the caller sent it. */
export type GatewayJobInput = { readonly [key: string]: JsonValue };

/** One stored output; `url` is origin-relative R2 until the API absolutizes it. */
export type GatewayJobOutput = {
  url: string;
  path: string;
  contentType: string;
};

export const GATEWAY_ERROR_CODES = [
  'CONTENT_REJECTED',
  'GENERATION_FAILED',
  'NOT_STARTED',
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/** What a caller reads for each code; the provider's own text stays in the logs and the row. */
export const GATEWAY_ERROR_MESSAGES: Readonly<
  Record<GatewayErrorCode, string>
> = {
  CONTENT_REJECTED: 'The provider refused the content of this request.',
  GENERATION_FAILED: 'The provider could not complete this job.',
  NOT_STARTED:
    'The job could not be started. Send it again with a new Idempotency-Key.',
};

export type GatewayJobError = { code: GatewayErrorCode; message: string };
