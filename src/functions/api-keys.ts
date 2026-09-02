/**
 * API Key Server Functions
 * End-to-end type-safe functions for managing team API keys
 *
 * Only team admins/owners can manage API keys.
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { API_KEY_PROVIDERS } from '@/lib/db/schema';
import { teamAdminAccessMiddleware } from './middleware';

const providerSchema = z.enum(API_KEY_PROVIDERS);

// ============================================================================
// List API Keys
// ============================================================================

const listApiKeysInputSchema = z.object({
  teamId: z.string(),
});

/**
 * List all API keys for a team (metadata only, no decrypted keys).
 */
export const listApiKeysFn = createServerFn({ method: 'GET' })
  .middleware([teamAdminAccessMiddleware])
  .validator(zodValidator(listApiKeysInputSchema))
  .handler(async ({ context }) => {
    return context.scopedDb.apiKeys.listKeys();
  });

// ============================================================================
// Save API Key
// ============================================================================

const saveApiKeyInputSchema = z.object({
  teamId: z.string(),
  provider: providerSchema,
  apiKey: z.string().min(1, 'API key is required'),
});

/**
 * Save (or update) an API key for a team.
 * Validates the key against the provider before saving.
 */
export const saveApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([teamAdminAccessMiddleware])
  .validator(zodValidator(saveApiKeyInputSchema))
  .handler(async ({ data, context }) => {
    // Validate the key first
    const validation = await context.scopedDb.apiKeys.validateKey(
      data.provider,
      data.apiKey
    );
    if (!validation.valid) {
      throw new Error(
        `Invalid API key: ${validation.error ?? 'Validation failed'}`
      );
    }

    return context.scopedDb.apiKeys.saveKey({
      provider: data.provider,
      apiKey: data.apiKey,
      source: 'manual',
    });
  });

// ============================================================================
// Delete API Key
// ============================================================================

const deleteApiKeyInputSchema = z.object({
  teamId: z.string(),
  provider: providerSchema,
});

/**
 * Delete a team's API key for a specific provider.
 * Falls back to platform key after deletion.
 */
export const deleteApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([teamAdminAccessMiddleware])
  .validator(zodValidator(deleteApiKeyInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.apiKeys.deleteKey(data.provider);
  });

// ============================================================================
// Check Key Status
// ============================================================================

const checkApiKeyStatusInputSchema = z.object({
  teamId: z.string(),
});

/**
 * Check which providers have user-provided keys vs. platform keys.
 */
export const checkApiKeyStatusFn = createServerFn({ method: 'GET' })
  .middleware([teamAdminAccessMiddleware])
  .validator(zodValidator(checkApiKeyStatusInputSchema))
  .handler(async ({ context }) => {
    const [hasOpenRouter, hasFal, hasXai, hasGoogle] = await Promise.all([
      context.scopedDb.apiKeys.hasKey('openrouter'),
      context.scopedDb.apiKeys.hasKey('fal'),
      context.scopedDb.apiKeys.hasKey('xai'),
      context.scopedDb.apiKeys.hasKey('google'),
    ]);

    return {
      openrouter: hasOpenRouter ? 'team' : 'platform',
      fal: hasFal ? 'team' : 'platform',
      xai: hasXai ? 'team' : 'platform',
      google: hasGoogle ? 'team' : 'platform',
    } as const;
  });

// ============================================================================
// Revalidate API Key
// ============================================================================

const revalidateApiKeyInputSchema = z.object({
  teamId: z.string(),
  provider: providerSchema,
});

/**
 * Re-run the provider's validation check against the currently stored team
 * key. Persists the result (isInvalid + invalidReason) on the team_api_keys
 * row so subsequent billing-gate reads reflect the current state.
 */
export const revalidateApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([teamAdminAccessMiddleware])
  .validator(zodValidator(revalidateApiKeyInputSchema))
  .handler(async ({ data, context }) => {
    return context.scopedDb.apiKeys.revalidateStoredKey(data.provider);
  });
