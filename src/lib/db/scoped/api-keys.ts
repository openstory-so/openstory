/**
 * Scoped API Keys Sub-module
 * Team-scoped API key management for external providers (OpenRouter, Fal.ai).
 * Handles CRUD operations and key resolution (team key -> platform fallback).
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import { getEnv } from '#env';
import { getPlatformLlmKey } from '@/lib/ai/create-adapter';
import {
  decryptApiKey,
  encryptApiKey,
  getKeyHint,
} from '@/lib/crypto/api-key-encryption';
import { type ApiKeyProvider, teamApiKeys } from '@/lib/db/schema';

import { getLogger, serializeError } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'db', 'api-keys']);

type ApiKeyInfo = {
  id: string;
  provider: ApiKeyProvider;
  keyHint: string;
  source: 'oauth' | 'manual';
  isActive: boolean;
  isInvalid: boolean;
  invalidReason: string | null;
  lastValidatedAt: Date | null;
  addedBy: string;
  createdAt: Date;
};

// `fallbackReason` is set when a team key existed but was skipped (invalid
// or undecryptable); callers use it to surface the BYOK fallback.
export type ResolvedApiKey =
  | { key: string; source: 'team' }
  | { key: string; source: 'platform'; fallbackReason?: string };

// LLM-call key resolution. `via` says which API the call must be routed
// through: 'openrouter' = OpenRouter directly (Bearer auth), 'fal' = fal's
// OpenAI-compatible OpenRouter endpoint (`Key` auth) so a team with only a
// fal key still covers LLM calls (issue #895).
export type ResolvedLlmKey = ResolvedApiKey & { via: 'openrouter' | 'fal' };

// The cached shape of a `team_api_keys` lookup. Holds the *encrypted* row
// (ciphertext + invalid flag) only — never the decrypted key. `resolveKey`
// memoizes this per scope to avoid redundant D1 reads, then decrypts fresh on
// each call so plaintext is never retained in the cache (issue #864).
type CachedKeyLookup =
  | { found: false }
  | {
      found: true;
      encryptedKey: string;
      keyIv: string;
      keyTag: string;
      isInvalid: boolean;
      invalidReason: string | null;
    };

export function createApiKeysReadMethods(db: Database, teamId: string) {
  // Per-scope memoization of the `team_api_keys` row lookup. A ScopedDb is
  // built fresh per workflow run / request, so this cache lives exactly one
  // run — there is no cross-run staleness (issue #864). Without it, `resolveKey`
  // runs a fresh D1 SELECT for every LLM/fal sub-call; under burst (the #801
  // 90-sequence render) the redundant identical reads exhausted D1 and
  // hard-failed sequences in phase 3.
  //
  // We cache only the *encrypted* row (ciphertext + invalid flag), never the
  // decrypted key — `resolveKey` decrypts fresh on each call, so the plaintext
  // key lives only for the duration of one call rather than the whole run. The
  // cache is in-isolate heap, scoped to one team, and never persisted.
  const keyLookupCache = new Map<ApiKeyProvider, Promise<CachedKeyLookup>>();

  // Drop a cached lookup so the next resolveKey re-reads from D1. Called by the
  // write methods after a save/delete/mark so a rotation or invalidation
  // within the same scope can't keep serving the stale row.
  function invalidateResolveKeyCache(provider?: ApiKeyProvider): void {
    if (provider) keyLookupCache.delete(provider);
    else keyLookupCache.clear();
  }

  async function listKeys(): Promise<ApiKeyInfo[]> {
    const rows = await db
      .select({
        id: teamApiKeys.id,
        provider: teamApiKeys.provider,
        keyHint: teamApiKeys.keyHint,
        source: teamApiKeys.source,
        isActive: teamApiKeys.isActive,
        isInvalid: teamApiKeys.isInvalid,
        invalidReason: teamApiKeys.invalidReason,
        lastValidatedAt: teamApiKeys.lastValidatedAt,
        addedBy: teamApiKeys.addedBy,
        createdAt: teamApiKeys.createdAt,
      })
      .from(teamApiKeys)
      .where(eq(teamApiKeys.teamId, teamId));

    return rows;
  }

  async function hasKey(provider: ApiKeyProvider): Promise<boolean> {
    const [row] = await db
      .select({ id: teamApiKeys.id })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true)
        )
      )
      .limit(1);

    return !!row;
  }

  // Like `hasKey` but excludes keys flagged invalid. Billing gates must use
  // this: an invalid key can't pay for anything — `resolveKey`/`resolveLlmKey`
  // skip it and fall back to the platform key, which deducts credits — so it
  // must not bypass a credit check or render as covering generation.
  async function hasUsableKey(provider: ApiKeyProvider): Promise<boolean> {
    const [row] = await db
      .select({ id: teamApiKeys.id })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true),
          eq(teamApiKeys.isInvalid, false)
        )
      )
      .limit(1);

    return !!row;
  }

  async function hasInvalidKey(provider: ApiKeyProvider): Promise<boolean> {
    const [row] = await db
      .select({ id: teamApiKeys.id })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true),
          eq(teamApiKeys.isInvalid, true)
        )
      )
      .limit(1);

    return !!row;
  }

  // Read the encrypted `team_api_keys` row for `provider`, memoized per scope:
  // D1 is hit at most once per provider per run, and concurrent in-flight reads
  // collapse onto the same promise. A rejected read is evicted so a later caller
  // (or a step retry in a surviving isolate) can re-read rather than inheriting
  // a cached failure.
  function readKeyRow(provider: ApiKeyProvider): Promise<CachedKeyLookup> {
    const cached = keyLookupCache.get(provider);
    if (cached) return cached;

    const pending = readKeyRowUncached(provider);
    keyLookupCache.set(provider, pending);
    void pending.catch(() => {
      if (keyLookupCache.get(provider) === pending) {
        keyLookupCache.delete(provider);
      }
    });
    return pending;
  }

  async function readKeyRowUncached(
    provider: ApiKeyProvider
  ): Promise<CachedKeyLookup> {
    const [row] = await db
      .select({
        encryptedKey: teamApiKeys.encryptedKey,
        keyIv: teamApiKeys.keyIv,
        keyTag: teamApiKeys.keyTag,
        isInvalid: teamApiKeys.isInvalid,
        invalidReason: teamApiKeys.invalidReason,
      })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true)
        )
      )
      .limit(1);

    if (!row) return { found: false };
    return { found: true, ...row };
  }

  // Read + memoize the row for `provider`, logging D1 failures in-isolate.
  async function readKeyRowLogged(
    provider: ApiKeyProvider
  ): Promise<CachedKeyLookup> {
    try {
      return await readKeyRow(provider);
    } catch (err) {
      // The D1 read failed. Log the FULL cause chain here, in-isolate, while
      // the underlying driver error is still on `DrizzleQueryError.cause` —
      // that link is stripped once the error crosses a Cloudflare Workflows
      // step boundary, so this is the only place the real D1 reason (overload
      // vs connection-reset vs rate-limit) is observable. This read sits on
      // every generation path and is the first to fail under burst (#864).
      logger.error('team_api_keys read failed', {
        provider,
        teamId,
        err: serializeError(err),
      });
      throw err;
    }
  }

  // Decrypt a found, non-invalid row. On decryption failure, marks the row
  // invalid (so the invalid-key banner surfaces and later calls skip the
  // doomed decrypt) and returns the skip reason instead of a key.
  async function decryptOrMarkInvalid(
    provider: ApiKeyProvider,
    lookup: CachedKeyLookup & { found: true }
  ): Promise<{ key: string } | { skippedReason: string }> {
    try {
      const decrypted = await decryptApiKey({
        encryptedKey: lookup.encryptedKey,
        keyIv: lookup.keyIv,
        keyTag: lookup.keyTag,
      });
      return { key: decrypted };
    } catch (err) {
      // Mark the row invalid inline so the invalid-key banner surfaces and
      // subsequent calls skip straight to the fallback without retrying
      // decryption (covers secret rotation and corrupt ciphertext).
      const reason =
        err instanceof Error
          ? `Could not decrypt stored key: ${err.message}`
          : 'Could not decrypt stored key';
      logger.error('Decryption failed, marking key invalid', {
        provider,
        teamId,
        error: err,
      });
      await db
        .update(teamApiKeys)
        .set({
          isInvalid: true,
          invalidReason: reason,
          lastValidatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(teamApiKeys.teamId, teamId),
            eq(teamApiKeys.provider, provider)
          )
        );
      // Flip the cached lookup to invalid so other calls in this scope skip the
      // doomed decrypt and don't re-issue the mark-invalid UPDATE.
      keyLookupCache.set(
        provider,
        Promise.resolve({ ...lookup, isInvalid: true, invalidReason: reason })
      );
      return { skippedReason: reason };
    }
  }

  function platformKeyFor(provider: ApiKeyProvider): string | undefined {
    const env = getEnv();
    switch (provider) {
      case 'openrouter':
        return env.OPENROUTER_KEY || undefined;
      case 'fal':
        return env.FAL_KEY || undefined;
      default: {
        const _exhaustive: never = provider;
        throw new Error(`Unknown provider: ${String(_exhaustive)}`);
      }
    }
  }

  // Missing key is undefined, not an error: native-provider routing (#1216)
  // uses this to skip to the next provider (usually fal). `resolveKey` wraps
  // this and throws, which is what fal's always-claim path needs.
  async function resolveOptionalKey(
    provider: ApiKeyProvider
  ): Promise<ResolvedApiKey | undefined> {
    function platformFallback(
      fallbackReason?: string
    ): ResolvedApiKey | undefined {
      const platformKey = platformKeyFor(provider);
      if (!platformKey) return undefined;
      return { key: platformKey, source: 'platform', fallbackReason };
    }

    const lookup = await readKeyRowLogged(provider);

    if (!lookup.found) return platformFallback();

    if (lookup.isInvalid) {
      const reason = lookup.invalidReason ?? 'Team API key marked invalid';
      logger.warn('Falling back to platform key', {
        provider,
        teamId,
        reason,
      });
      return platformFallback(reason);
    }

    const result = await decryptOrMarkInvalid(provider, lookup);
    if ('key' in result) return { key: result.key, source: 'team' };
    return platformFallback(result.skippedReason);
  }

  // Resolve the usable key for `provider`. The D1 lookup is memoized per scope;
  // the decrypted key is produced fresh on every call (and is GC-eligible as
  // soon as the caller is done), so plaintext is never retained in the cache.
  async function resolveKey(provider: ApiKeyProvider): Promise<ResolvedApiKey> {
    const resolved = await resolveOptionalKey(provider);
    if (!resolved) {
      throw new Error(`No API key available for provider: ${provider}`);
    }
    return resolved;
  }

  // Resolve the key for an LLM call. Preference order:
  //   1. team OpenRouter key (direct OpenRouter)
  //   2. team fal key (routed through fal's OpenRouter endpoint) — a fal-only
  //      team still covers LLM calls on their own key (issue #895)
  //   3. platform key (OPENROUTER_KEY, or FAL_KEY routed through fal)
  // A skipped OpenRouter key that a working fal key supersedes returns
  // `source: 'team'` with no fallbackReason — the reason only surfaces when
  // resolution falls all the way through to the platform key.
  async function resolveLlmKey(): Promise<ResolvedLlmKey> {
    let fallbackReason: string | undefined;

    const orLookup = await readKeyRowLogged('openrouter');
    if (orLookup.found) {
      if (orLookup.isInvalid) {
        fallbackReason =
          orLookup.invalidReason ?? 'Team OpenRouter key marked invalid';
      } else {
        const result = await decryptOrMarkInvalid('openrouter', orLookup);
        if ('key' in result) {
          return { key: result.key, source: 'team', via: 'openrouter' };
        }
        fallbackReason = result.skippedReason;
      }
    }

    const falLookup = await readKeyRowLogged('fal');
    if (falLookup.found) {
      if (falLookup.isInvalid) {
        fallbackReason ??=
          falLookup.invalidReason ?? 'Team fal key marked invalid';
      } else {
        const result = await decryptOrMarkInvalid('fal', falLookup);
        if ('key' in result) {
          return { key: result.key, source: 'team', via: 'fal' };
        }
        fallbackReason ??= result.skippedReason;
      }
    }

    const platform = getPlatformLlmKey();
    if (!platform) {
      throw new Error(
        'No platform LLM key available (set OPENROUTER_KEY or FAL_KEY)'
      );
    }
    if (fallbackReason) {
      logger.warn('Falling back to platform key', {
        provider: platform.via,
        teamId,
        reason: fallbackReason,
      });
    }
    return { ...platform, fallbackReason };
  }

  async function validateKey(
    provider: ApiKeyProvider,
    apiKey: string
  ): Promise<{ valid: boolean; error?: string }> {
    switch (provider) {
      case 'openrouter': {
        const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (response.ok) return { valid: true };
        return {
          valid: false,
          error: `OpenRouter returned ${response.status}`,
        };
      }
      case 'fal': {
        const response = await fetch(
          'https://queue.fal.run/fal-ai/flux/schnell',
          {
            method: 'POST',
            headers: {
              Authorization: `Key ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
          }
        );
        if (response.status === 401) {
          return { valid: false, error: 'Invalid Fal.ai API key' };
        }
        return { valid: true };
      }
      default: {
        const _exhaustive: never = provider;
        throw new Error(`Unknown provider: ${String(_exhaustive)}`);
      }
    }
  }

  return {
    listKeys,
    hasKey,
    hasUsableKey,
    hasInvalidKey,
    resolveKey,
    resolveOptionalKey,
    resolveLlmKey,
    validateKey,
    invalidateResolveKeyCache,
  };
}

export function createApiKeysMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const readMethods = createApiKeysReadMethods(db, teamId);

  const markKeyInvalid = async (
    provider: ApiKeyProvider,
    reason: string
  ): Promise<void> => {
    await db
      .update(teamApiKeys)
      .set({
        isInvalid: true,
        invalidReason: reason,
        lastValidatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(teamApiKeys.teamId, teamId), eq(teamApiKeys.provider, provider))
      );
    readMethods.invalidateResolveKeyCache(provider);
  };

  const markKeyValid = async (provider: ApiKeyProvider): Promise<void> => {
    await db
      .update(teamApiKeys)
      .set({
        isInvalid: false,
        invalidReason: null,
        lastValidatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(teamApiKeys.teamId, teamId), eq(teamApiKeys.provider, provider))
      );
    readMethods.invalidateResolveKeyCache(provider);
  };

  const revalidateStoredKey = async (
    provider: ApiKeyProvider
  ): Promise<{ valid: boolean; error?: string; hasKey: boolean }> => {
    const [row] = await db
      .select({
        encryptedKey: teamApiKeys.encryptedKey,
        keyIv: teamApiKeys.keyIv,
        keyTag: teamApiKeys.keyTag,
      })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true)
        )
      )
      .limit(1);

    if (!row) return { valid: false, hasKey: false };

    let decrypted: string;
    try {
      decrypted = await decryptApiKey({
        encryptedKey: row.encryptedKey,
        keyIv: row.keyIv,
        keyTag: row.keyTag,
      });
    } catch (err) {
      const reason =
        err instanceof Error
          ? `Could not decrypt stored key: ${err.message}`
          : 'Could not decrypt stored key';
      await markKeyInvalid(provider, reason);
      return { valid: false, error: reason, hasKey: true };
    }

    const result = await readMethods.validateKey(provider, decrypted);

    if (result.valid) {
      await markKeyValid(provider);
    } else {
      await markKeyInvalid(provider, result.error ?? 'Validation failed');
    }

    return { ...result, hasKey: true };
  };

  return {
    ...readMethods,

    markKeyInvalid,
    markKeyValid,
    revalidateStoredKey,

    saveKey: async (params: {
      provider: ApiKeyProvider;
      apiKey: string;
      source?: 'oauth' | 'manual';
    }): Promise<ApiKeyInfo> => {
      const encrypted = await encryptApiKey(params.apiKey);
      const hint = getKeyHint(params.apiKey);
      const now = new Date();

      await db
        .delete(teamApiKeys)
        .where(
          and(
            eq(teamApiKeys.teamId, teamId),
            eq(teamApiKeys.provider, params.provider)
          )
        );

      const [row] = await db
        .insert(teamApiKeys)
        .values({
          teamId,
          provider: params.provider,
          encryptedKey: encrypted.encryptedKey,
          keyIv: encrypted.keyIv,
          keyTag: encrypted.keyTag,
          keyHint: hint,
          source: params.source ?? 'manual',
          isActive: true,
          isInvalid: false,
          invalidReason: null,
          lastValidatedAt: now,
          addedBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!row) {
        throw new Error(
          `saveKey: insert returned no row for team ${teamId}, provider ${params.provider}`
        );
      }

      readMethods.invalidateResolveKeyCache(params.provider);

      return {
        id: row.id,
        provider: row.provider,
        keyHint: row.keyHint,
        source: row.source,
        isActive: row.isActive,
        isInvalid: row.isInvalid,
        invalidReason: row.invalidReason,
        lastValidatedAt: row.lastValidatedAt,
        addedBy: row.addedBy,
        createdAt: row.createdAt,
      };
    },

    deleteKey: async (provider: ApiKeyProvider): Promise<void> => {
      await db
        .delete(teamApiKeys)
        .where(
          and(
            eq(teamApiKeys.teamId, teamId),
            eq(teamApiKeys.provider, provider)
          )
        );
      readMethods.invalidateResolveKeyCache(provider);
    },
  };
}
