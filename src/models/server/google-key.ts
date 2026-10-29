/**
 * The one place a media call asks for a Google key. Three vias used to carry
 * their own copy of this resolver; the region memo (`google-region.ts`) has
 * to be consulted by every one of them, so they share it.
 */

import { getEnv } from '#env';
import { isGoogleRegionBlockedHere } from '@/models/google-region';
import type { ResolvedApiKey } from '@/models/server/db/api-keys';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';

/**
 * The Google key for a call that is about to choose its via. Undefined when
 * no key exists — the model then goes to fal as it always did — and also when
 * Google has refused this isolate's location, so the via is chosen as if the
 * deployment had no Google key. Under E2E a native via is off unless its base
 * URL points at the mock, so a laptop key cannot bill a test run or slip past
 * the recorder.
 */
export async function resolveGoogleKeyForNewCall(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !env.GEMINI_BASE_URL) return undefined;
  if (isGoogleRegionBlockedHere()) return undefined;
  return resolveGoogleKeyForStampedJob(credentials);
}

/**
 * The Google key for a job already stamped `google`: poll MUST follow the
 * stamp, so this ignores the region memo. Undefined only when no key exists.
 */
export async function resolveGoogleKeyForStampedJob(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('google');
  const platformKey = getEnv().GEMINI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}
