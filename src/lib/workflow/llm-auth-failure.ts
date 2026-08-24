/**
 * Shared workflow-failure handling for LLM auth errors. LLM calls can run on
 * the team's OpenRouter key, their fal key via fal's OpenRouter endpoint
 * (issue #895), or their LLMTR key, so a 401 must be pinned on the key the run
 * actually resolved — not blindly on the OpenRouter key.
 */

import type { ResolvedLlmKey } from '@/lib/db/scoped/api-keys';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { isLlmAuthError } from './sanitize-fail-response';

/**
 * If a workflow failure looks like the LLM provider rejecting the API key,
 * mark the team key the run resolved as invalid and return a user-facing
 * message naming that key. Returns undefined when the failure isn't an auth
 * error or the run was on the platform key (an ops problem, not the team's).
 */
export async function handleLlmAuthFailure(
  scopedDb: WorkflowScopedDb,
  sanitizedError: string
): Promise<string | undefined> {
  if (!isLlmAuthError(sanitizedError)) return undefined;

  // Re-resolve to find which key the failed run used. Resolution is
  // deterministic on DB state, so this returns the same key the LLM call got
  // — a key already flagged invalid resolves past itself, exactly as the
  // call did. The catch covers a missing platform key ('No platform LLM key
  // available'): nothing to mark, fall through to the raw error.
  const llmKey = await scopedDb.credentials
    .resolveLlmKey()
    .catch(() => undefined);
  if (llmKey?.source !== 'team') return undefined;

  await scopedDb.apiKeys.markKeyInvalid(llmKey.via, sanitizedError);
  return `Your ${LLM_KEY_LABELS[llmKey.via]} API key is invalid — update it in Settings.`;
}

const LLM_KEY_LABELS: Record<ResolvedLlmKey['via'], string> = {
  openrouter: 'OpenRouter',
  fal: 'fal.ai',
  xai: 'xAI',
  llmtr: 'LLMTR',
};
