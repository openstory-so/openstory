/**
 * Management server functions for PUBLIC-API keys — the keys external callers
 * use to authenticate against `/api/v1/*`. Distinct from `api-keys.ts`, which
 * manages a team's *provider* keys (OpenRouter/Fal) for server-side model
 * calls.
 *
 * Thin wrappers over the Better Auth `apiKey` plugin endpoints, run under the
 * dashboard's cookie session so the plugin scopes every key to the signed-in
 * user (`referenceId = user.id`); the team is derived from the user downstream
 * by `resolveUserTeam`.
 *
 * The plaintext key is returned exactly once, by `createPublicApiKeyFn`.
 * Listing only ever exposes the stored `start`/`prefix` hint, never the secret.
 */

import { getAuth } from '@/lib/auth/config';
import { getLogger } from '@/lib/observability/logger';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const logger = getLogger(['openstory', 'serverFn', 'public-api-keys']);

/** Keys are branded `osk_` (OpenStory Key) for easy recognition in logs/UX. */
const PUBLIC_API_KEY_PREFIX = 'osk_';

const createPublicApiKeySchema = z.object({
  name: z.string().min(1).max(32),
  /**
   * Optional lifetime in days. Omit for a non-expiring key. Bounded to a year
   * to match the plugin's `keyExpiration.maxExpiresIn` default.
   */
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const revokePublicApiKeySchema = z.object({
  keyId: z.string().min(1),
});

/**
 * The public-facing shape of a stored key — never includes the secret. `start`
 * is the first few characters the plugin retains so the UI can show e.g.
 * `osk_abc…` to disambiguate keys.
 */
export type PublicApiKeySummary = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  lastRequest: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
};

/**
 * Create a new public-API key. Returns the plaintext `key` ONCE — it is never
 * retrievable again, so the UI must surface it to the user immediately.
 */
export const createPublicApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(createPublicApiKeySchema))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ id: string; key: string; name: string }> => {
      const auth = getAuth();
      const created = await auth.api.createApiKey({
        headers: getRequestHeaders(),
        body: {
          name: data.name,
          prefix: PUBLIC_API_KEY_PREFIX,
          expiresIn: data.expiresInDays
            ? data.expiresInDays * 24 * 60 * 60
            : null,
        },
      });

      logger.info('public api key created', {
        userId: context.user.id,
        teamId: context.teamId,
        keyId: created.id,
      });

      return { id: created.id, key: created.key, name: data.name };
    }
  );

/** List the signed-in user's public-API keys (no secrets). */
export const listPublicApiKeysFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async (): Promise<PublicApiKeySummary[]> => {
    const auth = getAuth();
    const { apiKeys } = await auth.api.listApiKeys({
      headers: getRequestHeaders(),
    });
    return apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      start: key.start,
      prefix: key.prefix,
      enabled: key.enabled,
      lastRequest: key.lastRequest,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    }));
  });

/** Permanently revoke (delete) a public-API key the signed-in user owns. */
export const revokePublicApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(revokePublicApiKeySchema))
  .handler(async ({ data, context }): Promise<{ success: boolean }> => {
    const auth = getAuth();
    await auth.api.deleteApiKey({
      headers: getRequestHeaders(),
      body: { keyId: data.keyId },
    });

    logger.info('public api key revoked', {
      userId: context.user.id,
      teamId: context.teamId,
      keyId: data.keyId,
    });

    return { success: true };
  });
