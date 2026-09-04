/**
 * Shared workflow-failure handling for LLM auth errors. LLM calls can run on
 * the team's OpenRouter, fal, xAI, Google, or LLMTR key, so a 401 must be
 * pinned on the key the run actually resolved — not blindly on OpenRouter.
 */

import type { ResolvedLlmKey } from '@/lib/db/scoped/api-keys';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { isLlmAuthError } from './sanitize-fail-response';

/**
 * If a workflow failure looks like the LLM provider rejecting the API key,
 * mark the team key the run resolved as invalid and return a user-facing
 * message naming that key. Returns undefined when the failure isn't an auth
 * error or the run was on the platform key (an ops problem, not the team's).
 *
 * Pass `model` — the model the failed call used. Omitting it skips xAI /
 * Google / LLMTR routing and can pin the 401 on the wrong key.
 */
export async function handleLlmAuthFailure(
  scopedDb: WorkflowScopedDb,
  sanitizedError: string,
  model?: string
): Promise<string | undefined> {
  if (!isLlmAuthError(sanitizedError)) return undefined;

  const llmKey = await scopedDb.credentials
    .resolveLlmKey(model)
    .catch(() => undefined);
  if (llmKey?.source !== 'team') return undefined;

  await scopedDb.apiKeys.markKeyInvalid(llmKey.via, sanitizedError);
  return `Your ${LLM_KEY_LABELS[llmKey.via]} API key is invalid — update it in Settings.`;
}

const LLM_KEY_LABELS: Record<ResolvedLlmKey['via'], string> = {
  openrouter: 'OpenRouter',
  fal: 'fal.ai',
  xai: 'xAI',
  google: 'Google',
  llmtr: 'LLMTR',
};
