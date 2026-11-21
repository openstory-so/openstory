/** Gateway wire types, shared by the API and the UI (docs/architecture/model-gateway.md). */

import type { MediaVia } from '@/models/via';
import type { JsonValue } from '@/platform/server/db/schema';
import { APP_SKU_KEY_PATTERN } from '@/gateway/apps';
import { z } from 'zod';

/** modelschemas provider ids: the `{provider}` in `/gateway/{provider}/{model}`. */
export const GATEWAY_PROVIDERS = ['fal', 'byteplus', 'gemini', 'grok'] as const;
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

export function isGatewayProvider(value: string): value is GatewayProvider {
  return GATEWAY_PROVIDERS.some((provider) => provider === value);
}

/** The via each provider's jobs are stamped with. */
export const GATEWAY_VIA: Readonly<Record<GatewayProvider, MediaVia>> = {
  fal: 'fal',
  byteplus: 'byteplus',
  gemini: 'google',
  grok: 'xai',
};

/** The provider a stamped via belongs to. */
export function gatewayProviderOfVia(via: MediaVia): GatewayProvider {
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

export type GatewayJobError = { code: GatewayErrorCode; message: string };

/** `POST /api/v1/gateway/charges`: one of the caller app's declared SKUs. */
export const gatewayChargeRequestSchema = z
  .object({
    sku: z
      .string()
      .regex(APP_SKU_KEY_PATTERN, 'A SKU key from Settings → Developer → Apps')
      .describe(
        "The key of an active SKU the app declared. Its price is the app's, never the request's."
      ),
  })
  .meta({ id: 'GatewayChargeRequest' });
