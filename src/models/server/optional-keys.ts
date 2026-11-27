/** The organization's key for a provider, else the platform's; undefined when neither exists. */

import { getEnv } from '#env';
import type { ResolvedApiKey } from '@/models/server/db/api-keys';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';

export async function resolveOptionalFalKey(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('fal');
  const platformKey = getEnv().FAL_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

export async function resolveOptionalXaiKey(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('xai');
  const platformKey = getEnv().XAI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}
