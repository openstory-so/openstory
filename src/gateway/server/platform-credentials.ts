/**
 * The only credentials a gateway job spends: the platform's keys. An
 * organization's own provider keys are never read, so every job is billed.
 */

import { resolvePlatformOptionalKey } from '@/models/server/db/api-keys';
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
