/**
 * The only credentials a gateway job spends: the platform's keys. An
 * organization's own provider keys are never read, so every job is billed.
 */

import { resolvePlatformOptionalKey } from '@/models/server/db/api-keys';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';

export type GatewayCredentials = CredentialScopedDb & {
  organizationId: string;
};

export function platformOnlyCredentials(scope: {
  organizationId: string;
  userId: string;
}): GatewayCredentials {
  return {
    organizationId: scope.organizationId,
    userId: scope.userId,
    resolveOptionalKey: async (provider) =>
      resolvePlatformOptionalKey(provider),
    resolveKey: async (provider) => {
      const key = resolvePlatformOptionalKey(provider);
      if (!key) throw new Error(`No platform key for provider: ${provider}`);
      return key;
    },
  };
}

/** `scopedDb` with its LLM key on the platform's, metered: the submit's likeness check spends no organization key and is charged to the organization once. */
export function withPlatformLlmKey<
  T extends {
    apiKeys: Pick<
      ScopedDb['apiKeys'],
      'resolveLlmKey' | 'resolvePlatformLlmKey'
    >;
  },
>(scopedDb: T): T {
  return {
    ...scopedDb,
    apiKeys: {
      ...scopedDb.apiKeys,
      resolveLlmKey: async (model) => {
        const key = model
          ? await scopedDb.apiKeys.resolvePlatformLlmKey(model, null)
          : null;
        if (!key) {
          throw new Error(
            'No platform LLM key available (set OPENROUTER_KEY or FAL_KEY)'
          );
        }
        return key;
      },
    },
  };
}
