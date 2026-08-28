/**
 * Shared text adapter factory.
 *
 * Creates TanStack AI adapters for our chat models. Grok models go to xAI
 * directly when an xAI key is resolvable (issue #1167); everything else — and
 * Grok with no xAI key — goes to OpenRouter, either directly or through fal's
 * OpenAI-compatible OpenRouter endpoint (so a team with only a fal key still
 * covers LLM calls — issue #895).
 */

import { getEnv } from '#env';
import {
  nativeGrokTextModel,
  type NativeGrokTextModel,
} from '@/lib/ai/grok-native';
import type { TextModel } from '@/lib/ai/models';
import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';
import { HTTPClient } from '@openrouter/sdk/lib/http';
import { createModel, extendAdapter } from '@tanstack/ai';
import { createGrokText } from '@tanstack/ai-grok';
import { createOpenRouterText, openRouterText } from '@tanstack/ai-openrouter';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'create-adapter']);

/**
 * fal's OpenAI-compatible OpenRouter proxy. Same model slugs and wire format
 * as OpenRouter's own `/api/v1`, billed to the fal account.
 */
const FAL_OPENROUTER_BASE_URL = 'https://fal.run/openrouter/router/openai/v1';

export type LlmKeyInfo = {
  key: string;
  /**
   * Which API the key belongs to: 'openrouter' calls OpenRouter directly
   * (Bearer auth), 'fal' routes through fal's OpenRouter endpoint (`Key`
   * auth — fal rejects Bearer there), 'xai' calls xAI's own Responses API
   * (Bearer auth, Grok models only — issue #1167).
   */
  via: 'openrouter' | 'fal' | 'xai';
};

// fal's endpoint authenticates with `Authorization: Key <FAL_KEY>` while the
// OpenRouter SDK hardcodes `Bearer`; rewrite the header on the way out.
function falAuthHttpClient(falKey: string): HTTPClient {
  const client = new HTTPClient();
  client.addHook('beforeRequest', (request) => {
    request.headers.set('Authorization', `Key ${falKey}`);
    return request;
  });
  return client;
}

/**
 * Resolve the platform-level LLM key from env. A Grok model prefers
 * XAI_API_KEY (#1167); otherwise OPENROUTER_KEY, and with only FAL_KEY set LLM
 * calls route through fal's OpenRouter endpoint — the platform can run on a
 * single fal key (issue #895). Returns undefined when none is configured.
 *
 * Omitting `model` keeps the OpenRouter-first order, which every model
 * supports — a caller that can't name the model can't promise it's a Grok one.
 */
export function getPlatformLlmKey(
  model?: string
): (LlmKeyInfo & { source: 'platform' }) | undefined {
  const env = getEnv();
  if (model && nativeGrokTextModel(model) && env.XAI_API_KEY) {
    return { key: env.XAI_API_KEY, via: 'xai', source: 'platform' };
  }
  if (env.OPENROUTER_KEY) {
    return { key: env.OPENROUTER_KEY, via: 'openrouter', source: 'platform' };
  }
  if (env.FAL_KEY) {
    return { key: env.FAL_KEY, via: 'fal', source: 'platform' };
  }
  return undefined;
}

let loggedRetryMode = false;

/**
 * Registry model ids the adapter's generated catalog doesn't know yet — the
 * catalog is a codegen snapshot of OpenRouter's live list and lags new
 * releases. `extendAdapter` widens the factories' typed model union so a
 * registry id that is in NEITHER list is a compile error instead of an
 * unsafe cast. `catalog-lag.test.ts` fails once an `@tanstack/ai-openrouter`
 * bump ships an id below, telling whoever lands that dependency bump (Dependabot)
 * to prune it here. Entries are ADDED by the model-freshness routine (#792) when
 * a text-model bump adopts an id the installed catalog doesn't know yet. Add
 * entries with `createModel` from '@tanstack/ai':
 * `createModel('vendor/model-id', { input: [...], features: [...] })`.
 *
 */
export const CATALOG_LAG_MODELS = [
  // Released 2026-08-26; 0.18.1's catalog stops at z-ai/glm-5.3 (#1367).
  createModel('z-ai/glm-5.3-flash', {
    input: ['text', 'image'],
    features: ['reasoning', 'structured_outputs'],
  }),
] as const;

const openRouterTextExtended = extendAdapter(
  openRouterText,
  CATALOG_LAG_MODELS
);
const createOpenRouterTextExtended = extendAdapter(
  createOpenRouterText,
  CATALOG_LAG_MODELS
);

/** {@link CATALOG_LAG_MODELS} for the Grok adapter. Native `grok-4.6` is
 *  in the 0.16 catalog; `grok-4.20-0309-reasoning` is still lag-bridged.
 *  Same prune contract as the OpenRouter list. */
const GROK_CATALOG_LAG_MODELS = [
  createModel('grok-4.20-0309-reasoning', {
    input: ['text', 'image'],
    features: ['reasoning', 'structured_outputs'],
  }),
] as const;

const createGrokTextExtended = extendAdapter(
  createGrokText,
  GROK_CATALOG_LAG_MODELS
);

/**
 * Whether a request goes to xAI directly, and under which model name. The
 * request body differs by route (xAI speaks the Responses API), so `llm-client`
 * asks this too rather than deciding for itself — that's what stops a
 * Responses-shaped body reaching OpenRouter, or the reverse.
 */
export function resolveNativeGrokModel(
  model: TextModel,
  keyInfo?: LlmKeyInfo
): NativeGrokTextModel | undefined {
  const resolved = keyInfo ?? getPlatformLlmKey(model);
  if (resolved?.via !== 'xai' || !resolved.key) return undefined;
  return nativeGrokTextModel(model);
}

// Callers must say which API a key belongs to (`via`) — a bare string can't:
// a fal key mistaken for an OpenRouter key gets Bearer auth against
// openrouter.ai and 401s at runtime, invisibly to the compiler.
export function createAdapter(model: TextModel, keyInfo?: LlmKeyInfo) {
  const env = getEnv();
  const resolved = keyInfo ?? getPlatformLlmKey(model);
  const key = resolved?.key;
  const via = resolved?.via ?? 'openrouter';

  const nativeModel = resolveNativeGrokModel(model, resolved);
  if (nativeModel && key) {
    return createGrokTextExtended(nativeModel, key, {
      fetch: workersSafeFetch,
      // XAI_BASE_URL points aimock at the native path in e2e, mirroring what
      // OPENROUTER_BASE_URL does for the OpenRouter path below.
      ...(env.XAI_BASE_URL && { baseURL: env.XAI_BASE_URL }),
    });
  }

  // An xAI key on the OpenRouter branch is the #1358 mismatch: resolveLlmKey
  // was asked for a Grok model, then the call used a different one. OpenRouter
  // answers that with "Missing Authentication header" (its text for any
  // non-sk-or key). Throw so the next mismatch is a stack, not a 401 puzzle.
  if (via === 'xai') {
    throw new Error(
      `xAI key cannot be sent to OpenRouter (model '${model}'). Resolve the LLM key for the model being called, not a different analysis model.`
    );
  }

  // During E2E recording, aimock proxies our OpenRouter calls upstream and
  // *buffers* the entire SSE response before relaying — see
  // node_modules/@copilotkit/aimock/dist/recorder.js. That buffering window
  // can trip the SDK's default backoff retry, producing two upstream calls
  // and two fixture files for the same prompt. Disable retry and stretch
  // the per-request timeout so the single proxied call has time to land.
  // Cloudflare Workflows retries failed `step.do` units at the workflow
  // layer, so this doesn't remove all retry coverage — only the SDK-internal
  // retry that fights with aimock's buffering during record.
  const isRecording = env.E2E_RECORD === '1';

  if (!loggedRetryMode) {
    loggedRetryMode = true;
    logger.info(
      `retry=${isRecording ? 'disabled' : 'sdk-default'} timeout=${isRecording ? '600000ms' : 'sdk-default'} E2E_RECORD=${env.E2E_RECORD ?? '<unset>'}`
    );
  }

  // OPENROUTER_BASE_URL (aimock in e2e) wins over the fal proxy so tests stay
  // hermetic regardless of which key the team resolved.
  const serverURL =
    env.OPENROUTER_BASE_URL ??
    (via === 'fal' ? FAL_OPENROUTER_BASE_URL : undefined);

  const config = {
    httpReferer: env.VITE_APP_URL || 'http://localhost:3000',
    xTitle: env.VITE_APP_NAME || 'OpenStory',
    ...(serverURL && { serverURL }),
    ...(via === 'fal' && key && { httpClient: falAuthHttpClient(key) }),
    ...(isRecording && {
      retryConfig: { strategy: 'none' as const },
      timeoutMs: 600_000,
    }),
  };

  return key
    ? createOpenRouterTextExtended(model, key, config)
    : openRouterTextExtended(model, config);
}
