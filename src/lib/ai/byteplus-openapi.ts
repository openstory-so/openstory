/**
 * BytePlus OpenAPI client for the Ark control plane (`*.byteplusapi.com`).
 *
 * Distinct from the data-plane (`ark.ap-southeast.bytepluses.com/api/v3`)
 * that `@tanstack/ai-byteplus` drives with `ARK_API_KEY`. Assets live here.
 */

import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';
import {
  buildCanonicalQuery,
  signBytePlusRequest,
  utcXDate,
} from './byteplus-openapi-sign';

const BYTEPLUS_OPENAPI_VERSION = '2024-01-01';
const BYTEPLUS_OPENAPI_SERVICE = 'ark';
const DEFAULT_BYTEPLUS_OPENAPI_HOST = 'ark.ap-southeast-1.byteplusapi.com';
const DEFAULT_BYTEPLUS_OPENAPI_REGION = 'ap-southeast-1';

export type BytePlusOpenApiConfig = {
  accessKey: string;
  secretKey: string;
  host?: string;
  region?: string;
  projectName?: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

export async function bytePlusOpenApi<T>(
  config: BytePlusOpenApiConfig,
  action: string,
  body: Record<string, unknown>
): Promise<T> {
  const host = config.host ?? DEFAULT_BYTEPLUS_OPENAPI_HOST;
  const region = config.region ?? DEFAULT_BYTEPLUS_OPENAPI_REGION;
  const payload = JSON.stringify(body);
  const query = buildCanonicalQuery({
    Action: action,
    Version: BYTEPLUS_OPENAPI_VERSION,
  });
  const headers = await signBytePlusRequest({
    method: 'POST',
    path: '/',
    query,
    host,
    region,
    service: BYTEPLUS_OPENAPI_SERVICE,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    body: payload,
    xDate: utcXDate(config.now?.() ?? new Date()),
  });
  const fetchImpl = config.fetch ?? workersSafeFetch;
  const response = await fetchImpl(`https://${host}/?${query}`, {
    method: 'POST',
    headers,
    body: payload,
  });
  const text = await response.text();
  const parsed = parseEnvelope<T>(text);
  const apiError = parsed.error;
  if (!response.ok || apiError) {
    const code = apiError?.Code ?? String(response.status);
    const message = apiError?.Message ?? text.slice(0, 500);
    throw new Error(
      `BytePlus OpenAPI ${action} failed (${code}): ${message || response.statusText}`
    );
  }
  if (parsed.result === undefined) {
    throw new Error(`BytePlus OpenAPI ${action} returned no Result`);
  }
  return parsed.result;
}

function parseEnvelope<T>(text: string): {
  result?: T;
  error?: { Code?: string; Message?: string };
} {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(value)) return {};
  const metadata = isRecord(value.ResponseMetadata)
    ? value.ResponseMetadata
    : undefined;
  const errorRaw = isRecord(metadata?.Error) ? metadata.Error : undefined;
  return {
    // Result shape is per-action; callers type it via bytePlusOpenApi<T>.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    result: value.Result as T | undefined,
    error: errorRaw
      ? {
          Code: typeof errorRaw.Code === 'string' ? errorRaw.Code : undefined,
          Message:
            typeof errorRaw.Message === 'string' ? errorRaw.Message : undefined,
        }
      : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function withProject(
  config: BytePlusOpenApiConfig,
  body: Record<string, unknown>
): Record<string, unknown> {
  const projectName = config.projectName ?? 'default';
  return { ...body, ProjectName: projectName };
}
