/**
 * Shared text adapter factory.
 *
 * Creates TanStack AI adapters for our chat models. Calls go to OpenRouter,
 * either directly or through fal's OpenAI-compatible OpenRouter endpoint (so
 * a team with only a fal key still covers LLM calls — issue #895).
 */

import { getEnv } from '#env';
import type { TextModel } from '@/lib/ai/models';
import { HTTPClient } from '@openrouter/sdk/lib/http';
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
   * auth — fal rejects Bearer there).
   */
  via: 'openrouter' | 'fal';
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
 * Resolve the platform-level LLM key from env. OPENROUTER_KEY is preferred;
 * with only FAL_KEY set, calls route through fal's OpenRouter endpoint, so the
 * platform can run on a single fal key (issue #895).
 */
export function getPlatformLlmKey():
  | (LlmKeyInfo & { source: 'platform' })
  | undefined {
  const env = getEnv();
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
 * Empty after @tanstack/ai-openrouter@0.18.1 shipped the current model set.
 * Restore `extendAdapter` around the factories when the next lag id lands.
 */
export const CATALOG_LAG_MODELS = [] as const;

// Callers must say which API a key belongs to (`via`) — a bare string can't:
// a fal key mistaken for an OpenRouter key gets Bearer auth against
// openrouter.ai and 401s at runtime, invisibly to the compiler.
export function createAdapter(model: TextModel, keyInfo?: LlmKeyInfo) {
  const env = getEnv();
  const resolved = keyInfo ?? getPlatformLlmKey();
  const key = resolved?.key;
  const via = resolved?.via ?? 'openrouter';

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
    ? createOpenRouterText(model, key, config)
    : openRouterText(model, config);
}
