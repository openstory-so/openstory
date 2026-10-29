// Google key lookup for media calls, so every new call consults the region memo.

import { getEnv } from '#env';
import { isGoogleRegionBlockedHere } from '@/models/google-region';
import type { ResolvedApiKey } from '@/models/server/db/api-keys';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';

/** Google key for a new call; undefined with no key, under E2E without the mock, or where Google refused this isolate. */
export async function resolveGoogleKeyForNewCall(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !env.GEMINI_BASE_URL) return undefined;
  if (isGoogleRegionBlockedHere()) return undefined;
  return resolveGoogleKeyForStampedJob(credentials);
}

/** Google key for a job stamped `google`; ignores the region memo because poll follows the stamp. */
export async function resolveGoogleKeyForStampedJob(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('google');
  const platformKey = getEnv().GEMINI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}
