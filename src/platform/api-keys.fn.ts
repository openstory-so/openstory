/**
 * API Key Server Functions
 * End-to-end type-safe functions for managing organization API keys
 *
 * Only organization admins/owners can manage API keys.
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { API_KEY_PROVIDERS } from '@/platform/server/db/schema';
import { organizationAdminAccessMiddleware } from './middleware.fn';

const providerSchema = z.enum(API_KEY_PROVIDERS);

// ============================================================================
// List API Keys
// ============================================================================

const listApiKeysInputSchema = z.object({
  organizationId: z.string(),
});

/**
 * List all API keys for an organization (metadata only, no decrypted keys).
 */
export const listApiKeysFn = createServerFn({ method: 'GET' })
  .middleware([organizationAdminAccessMiddleware])
  .validator(zodValidator(listApiKeysInputSchema))
  .handler(async ({ context }) => {
    return context.scopedDb.apiKeys.listKeys();
  });

// ============================================================================
// Save API Key
// ============================================================================

const saveApiKeyInputSchema = z.object({
  organizationId: z.string(),
  provider: providerSchema,
  apiKey: z.string().min(1, 'API key is required'),
});

/**
 * Save (or update) an API key for an organization.
 * Validates the key against the provider before saving.
 */
export const saveApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([organizationAdminAccessMiddleware])
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
  organizationId: z.string(),
  provider: providerSchema,
});

/**
 * Delete an organization's API key for a specific provider.
 * Falls back to platform key after deletion.
 */
export const deleteApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([organizationAdminAccessMiddleware])
  .validator(zodValidator(deleteApiKeyInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.apiKeys.deleteKey(data.provider);
  });

// ============================================================================
// Check Key Status
// ============================================================================

const checkApiKeyStatusInputSchema = z.object({
  organizationId: z.string(),
});

/**
 * Check which providers have user-provided keys vs. platform keys.
 */
export const checkApiKeyStatusFn = createServerFn({ method: 'GET' })
  .middleware([organizationAdminAccessMiddleware])
  .validator(zodValidator(checkApiKeyStatusInputSchema))
  .handler(async ({ context }) => {
    const [hasOpenRouter, hasFal, hasXai, hasGoogle, hasLlmtr, hasUploadPost] =
      await Promise.all([
        context.scopedDb.apiKeys.hasKey('openrouter'),
        context.scopedDb.apiKeys.hasKey('fal'),
        context.scopedDb.apiKeys.hasKey('xai'),
        context.scopedDb.apiKeys.hasKey('google'),
        context.scopedDb.apiKeys.hasKey('llmtr'),
        context.scopedDb.apiKeys.hasKey('upload_post'),
      ]);

    return {
      openrouter: hasOpenRouter ? 'organization' : 'platform',
      fal: hasFal ? 'organization' : 'platform',
      xai: hasXai ? 'organization' : 'platform',
      google: hasGoogle ? 'organization' : 'platform',
      llmtr: hasLlmtr ? 'organization' : 'none',
      upload_post: hasUploadPost ? 'organization' : 'none',
    } as const;
  });

// ============================================================================
// Revalidate API Key
// ============================================================================

const revalidateApiKeyInputSchema = z.object({
  organizationId: z.string(),
  provider: providerSchema,
});

/**
 * Re-run the provider's validation check against the currently stored organization
 * key. Persists the result (isInvalid + invalidReason) on the organization_api_keys
 * row so subsequent billing-gate reads reflect the current state.
 */
export const revalidateApiKeyFn = createServerFn({ method: 'POST' })
  .middleware([organizationAdminAccessMiddleware])
  .validator(zodValidator(revalidateApiKeyInputSchema))
  .handler(async ({ data, context }) => {
    return context.scopedDb.apiKeys.revalidateStoredKey(data.provider);
  });
