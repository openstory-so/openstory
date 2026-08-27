/**
 * In-memory DB tests for per-scope `resolveKey` memoization (issue #864).
 *
 * `resolveKey` previously ran a fresh D1 SELECT on `team_api_keys` for every
 * LLM/fal sub-call; under the #801 90-sequence burst the redundant identical
 * reads exhausted D1 and hard-failed sequences in phase 3. A `ScopedDb` is
 * built once per workflow run / request, so memoizing the row lookup on the
 * read-methods closure caps it to one read per provider per scope — with the
 * cache lifetime bounded to that one run, there is no cross-run staleness, and
 * the write methods invalidate the cache so a rotation within a scope can't
 * keep serving the old key.
 *
 * Security: the cache holds the *encrypted* row only; `resolveKey` decrypts
 * fresh on every call, so the plaintext key is never retained in the cache (the
 * `decryptSpy` test pins this).
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { teamApiKeys, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Mutable so individual tests can unset platform keys (restored in beforeEach).
const testEnv: {
  API_KEY_ENCRYPTION_KEY: string;
  OPENROUTER_KEY: string | undefined;
  FAL_KEY: string | undefined;
  XAI_API_KEY: string | undefined;
  GEMINI_API_KEY: string | undefined;
} = {
  API_KEY_ENCRYPTION_KEY: 'test-secret-for-api-keys-memoization',
  OPENROUTER_KEY: 'platform-openrouter-key',
  FAL_KEY: 'platform-fal-key',
  XAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
};

vi.doMock('#env', () => ({
  getEnv: () => testEnv,
}));

// Wrap the real `decryptApiKey` in a spy (delegating to the actual impl) so a
// test can assert decryption runs once per call — i.e. the cache holds
// ciphertext, not plaintext. `encryptApiKey` stays real so `saveKey` round-trips.
const decryptSpy = vi.fn();
vi.doMock('@/lib/crypto/api-key-encryption', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/crypto/api-key-encryption')
  >('@/lib/crypto/api-key-encryption');
  decryptSpy.mockImplementation(actual.decryptApiKey);
  return { ...actual, decryptApiKey: decryptSpy };
});

// Dynamic import so the mocks above apply to the module-under-test (and its
// crypto dependency) — see CLAUDE.md module-mocking pattern.
const { createApiKeysMethods, createApiKeysReadMethods } =
  await import('./api-keys');

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

/**
 * Wrap `db` in a Proxy that tallies every `select` so a test can assert how
 * many D1 reads a sequence of `resolveKey` calls actually issued. All methods
 * are bound to the real db so drizzle's internals still see the right `this`.
 */
function countingDb(): { db: Database; selects: () => number } {
  let selects = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'select') selects++;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, selects: () => selects };
}

async function seed() {
  await db.delete(teamApiKeys);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: `t-${teamId}` });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  testEnv.OPENROUTER_KEY = 'platform-openrouter-key';
  testEnv.FAL_KEY = 'platform-fal-key';
  testEnv.XAI_API_KEY = undefined;
  testEnv.GEMINI_API_KEY = undefined;
  await seed();
});

describe('resolveKey memoization (issue #864)', () => {
  it('reads team_api_keys once across repeated resolveKey calls in one scope', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-123',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    const r1 = await scope.resolveKey('openrouter');
    const r2 = await scope.resolveKey('openrouter');
    const r3 = await scope.resolveKey('openrouter');

    expect(r1).toEqual({ key: 'sk-team-123', source: 'team' });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(selects()).toBe(1);
  });

  it('decrypts per call and never caches the plaintext key', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-secret',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    decryptSpy.mockClear();
    await scope.resolveKey('openrouter');
    await scope.resolveKey('openrouter');
    await scope.resolveKey('openrouter');

    // One D1 read (the row is cached) but a fresh decrypt on every call — the
    // plaintext is re-derived per call, never held in the cache.
    expect(selects()).toBe(1);
    expect(decryptSpy).toHaveBeenCalledTimes(3);
  });

  it('collapses concurrent in-flight resolves to a single read', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-concurrent',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    const [r1, r2, r3] = await Promise.all([
      scope.resolveKey('openrouter'),
      scope.resolveKey('openrouter'),
      scope.resolveKey('openrouter'),
    ]);

    expect(r1).toEqual({ key: 'sk-team-concurrent', source: 'team' });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(selects()).toBe(1);
  });

  it('caches each provider independently (one read per provider)', async () => {
    const writeScope = createApiKeysMethods(db, teamId, userId);
    await writeScope.saveKey({ provider: 'openrouter', apiKey: 'sk-or' });
    await writeScope.saveKey({ provider: 'fal', apiKey: 'sk-fal' });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    await scope.resolveKey('openrouter');
    await scope.resolveKey('fal');
    await scope.resolveKey('openrouter');
    await scope.resolveKey('fal');

    expect(selects()).toBe(2);
  });

  it('memoizes the platform fallback when the team has no key', async () => {
    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    const r1 = await scope.resolveKey('fal');
    const r2 = await scope.resolveKey('fal');

    expect(r1).toEqual({ key: 'platform-fal-key', source: 'platform' });
    expect(r2).toEqual(r1);
    expect(selects()).toBe(1);
  });

  it('re-reads in a fresh scope (cache lifetime is one scope)', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-456',
    });

    const first = countingDb();
    await createApiKeysReadMethods(first.db, teamId).resolveKey('openrouter');
    expect(first.selects()).toBe(1);

    const second = countingDb();
    const r = await createApiKeysReadMethods(second.db, teamId).resolveKey(
      'openrouter'
    );
    expect(r).toEqual({ key: 'sk-team-456', source: 'team' });
    expect(second.selects()).toBe(1);
  });

  it('re-reads after a key is rotated within the same scope', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);

    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-v1' });
    const r1 = await scope.resolveKey('openrouter');
    expect(r1).toEqual({ key: 'sk-v1', source: 'team' });

    // Rotating the key invalidates the cached resolve; the next call must see
    // the new value, not the stale v1 it just cached.
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-v2' });
    const r2 = await scope.resolveKey('openrouter');
    expect(r2).toEqual({ key: 'sk-v2', source: 'team' });
  });

  it('re-reads after the key is deleted within the same scope', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);

    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-team-del' });
    expect(await scope.resolveKey('openrouter')).toEqual({
      key: 'sk-team-del',
      source: 'team',
    });

    await scope.deleteKey('openrouter');
    expect(await scope.resolveKey('openrouter')).toEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
    });
  });

  it('falls back to the platform key when the team key is marked invalid', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-bad' });
    await scope.markKeyInvalid('openrouter', 'rejected by provider');

    expect(await scope.resolveKey('openrouter')).toEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
      fallbackReason: 'rejected by provider',
    });
  });

  it('does not cache a failed resolve, so a retry can re-read', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-xyz',
    });

    let selectCalls = 0;
    const flakyDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'select') {
          selectCalls++;
          if (selectCalls === 1) {
            // Simulate a transient D1 overload on the very first read.
            return () => ({
              from: () => ({
                where: () => ({
                  limit: () => Promise.reject(new Error('D1 overloaded')),
                }),
              }),
            });
          }
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const scope = createApiKeysReadMethods(flakyDb, teamId);

    await expect(scope.resolveKey('openrouter')).rejects.toThrow(
      'D1 overloaded'
    );
    // The rejection must have been evicted — a second call re-reads and wins.
    const r = await scope.resolveKey('openrouter');
    expect(r).toEqual({ key: 'sk-team-xyz', source: 'team' });
  });
});

describe('resolveLlmKey (issue #895 — fal key covers LLM calls)', () => {
  it('prefers the team OpenRouter key when present', async () => {
    const writeScope = createApiKeysMethods(db, teamId, userId);
    await writeScope.saveKey({ provider: 'openrouter', apiKey: 'sk-or' });
    await writeScope.saveKey({ provider: 'fal', apiKey: 'sk-fal' });

    expect(await writeScope.resolveLlmKey()).toEqual({
      key: 'sk-or',
      source: 'team',
      via: 'openrouter',
    });
  });

  it('routes through fal when the team only has a fal key', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal-only' });

    expect(await scope.resolveLlmKey()).toEqual({
      key: 'sk-fal-only',
      source: 'team',
      via: 'fal',
    });
  });

  it('falls back to the platform OpenRouter key when the team has no keys', async () => {
    const scope = createApiKeysReadMethods(db, teamId);

    // toStrictEqual: `fallbackReason` must really be absent/undefined —
    // toEqual would treat `{ fallbackReason: 'x' }` as matching too few keys.
    expect(await scope.resolveLlmKey()).toStrictEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
      via: 'openrouter',
      fallbackReason: undefined,
    });
  });

  it('skips an invalid team OpenRouter key and uses the fal key instead', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-or-bad' });
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal-good' });
    await scope.markKeyInvalid('openrouter', 'rejected by provider');

    expect(await scope.resolveLlmKey()).toEqual({
      key: 'sk-fal-good',
      source: 'team',
      via: 'fal',
    });
  });

  it('falls back to platform with the skip reason when both team keys are invalid', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-or-bad' });
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal-bad' });
    await scope.markKeyInvalid('openrouter', 'openrouter rejected');
    await scope.markKeyInvalid('fal', 'fal rejected');

    expect(await scope.resolveLlmKey()).toEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
      via: 'openrouter',
      fallbackReason: 'openrouter rejected',
    });
  });

  it('routes the platform fallback through fal when OPENROUTER_KEY is unset', async () => {
    testEnv.OPENROUTER_KEY = undefined;
    const scope = createApiKeysReadMethods(db, teamId);

    expect(await scope.resolveLlmKey()).toStrictEqual({
      key: 'platform-fal-key',
      source: 'platform',
      via: 'fal',
      fallbackReason: undefined,
    });
  });

  it('falls back to platform with the reason when a fal-only team key is invalid', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal-bad' });
    await scope.markKeyInvalid('fal', 'fal rejected');

    // The skip must NOT be silent: callers surface fallbackReason so a
    // fal-only team learns their BYOK key stopped covering generation.
    expect(await scope.resolveLlmKey()).toStrictEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
      via: 'openrouter',
      fallbackReason: 'fal rejected',
    });
  });

  it('skips an undecryptable OpenRouter key, marks it invalid, and uses the fal key', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-or' });
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal' });

    decryptSpy.mockRejectedValueOnce(new Error('bad auth tag'));

    expect(await scope.resolveLlmKey()).toStrictEqual({
      key: 'sk-fal',
      source: 'team',
      via: 'fal',
    });

    const orKey = (await scope.listKeys()).find(
      (k) => k.provider === 'openrouter'
    );
    expect(orKey?.isInvalid).toBe(true);
    expect(orKey?.invalidReason).toBe(
      'Could not decrypt stored key: bad auth tag'
    );
  });

  it('falls back to platform with the decrypt-failure reason for a fal-only key', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal-corrupt' });

    decryptSpy.mockRejectedValueOnce(new Error('bad auth tag'));

    expect(await scope.resolveLlmKey()).toStrictEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
      via: 'openrouter',
      fallbackReason: 'Could not decrypt stored key: bad auth tag',
    });
  });

  it('skips the doomed decrypt on later calls in the same scope', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal-corrupt' });

    decryptSpy.mockRejectedValueOnce(new Error('bad auth tag'));
    await scope.resolveLlmKey();

    // The cached lookup was flipped to invalid in place — the second call
    // must not retry the decrypt (or re-issue the mark-invalid UPDATE).
    decryptSpy.mockClear();
    const r = await scope.resolveLlmKey();
    expect(r.source).toBe('platform');
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('throws when neither platform key is configured', async () => {
    testEnv.OPENROUTER_KEY = undefined;
    testEnv.FAL_KEY = undefined;
    const scope = createApiKeysReadMethods(db, teamId);

    await expect(scope.resolveLlmKey()).rejects.toThrow(
      'No platform LLM key available'
    );
  });

  it('shares the per-provider row cache with resolveKey (one read per provider)', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'fal',
      apiKey: 'sk-fal-cache',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    await scope.resolveLlmKey();
    await scope.resolveLlmKey();
    await scope.resolveKey('fal');

    // openrouter row (miss) + fal row, each read once across all calls.
    expect(selects()).toBe(2);
  });
});

describe('hasUsableKey (billing gates must not count invalid keys)', () => {
  it('is false for an invalid-flagged key that hasKey still reports', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'fal', apiKey: 'sk-fal' });

    expect(await scope.hasUsableKey('fal')).toBe(true);

    await scope.markKeyInvalid('fal', 'revoked');

    // hasKey stays true (the row is active) — that's why billing gates must
    // use hasUsableKey: this key won't pay for anything at call time.
    expect(await scope.hasKey('fal')).toBe(true);
    expect(await scope.hasUsableKey('fal')).toBe(false);

    await scope.markKeyValid('fal');
    expect(await scope.hasUsableKey('fal')).toBe(true);
  });

  it('is false when no key exists', async () => {
    const scope = createApiKeysReadMethods(db, teamId);
    expect(await scope.hasUsableKey('openrouter')).toBe(false);
  });
});

describe('native xAI key resolution (issue #1167)', () => {
  it('prefers a team xAI key for a Grok model', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-team-or' });
    await scope.saveKey({ provider: 'xai', apiKey: 'xai-team' });

    expect(await scope.resolveLlmKey('x-ai/grok-4.6')).toMatchObject({
      key: 'xai-team',
      source: 'team',
      via: 'xai',
    });
  });

  it('leaves non-Grok models on OpenRouter even with an xAI key stored', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-team-or' });
    await scope.saveKey({ provider: 'xai', apiKey: 'xai-team' });

    expect(
      await scope.resolveLlmKey('anthropic/claude-sonnet-5')
    ).toMatchObject({ key: 'sk-team-or', via: 'openrouter' });
  });

  it('keeps the pre-#1167 behaviour when the caller names no model', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'xai', apiKey: 'xai-team' });

    expect(await scope.resolveLlmKey()).toMatchObject({ via: 'openrouter' });
  });

  it('falls back to the platform XAI_API_KEY when the team has none', async () => {
    testEnv.XAI_API_KEY = 'platform-xai';
    const scope = createApiKeysReadMethods(db, teamId);

    expect(await scope.resolveLlmKey('x-ai/grok-4.6')).toMatchObject({
      key: 'platform-xai',
      source: 'platform',
      via: 'xai',
    });
  });

  it('falls through to OpenRouter for a Grok model with no xAI key anywhere', async () => {
    const scope = createApiKeysReadMethods(db, teamId);

    expect(await scope.resolveLlmKey('x-ai/grok-4.6')).toMatchObject({
      key: 'platform-openrouter-key',
      via: 'openrouter',
    });
  });

  it('skips an xAI key flagged invalid rather than sending it', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'xai', apiKey: 'xai-team' });
    await scope.markKeyInvalid('xai', 'revoked');

    expect(await scope.resolveLlmKey('x-ai/grok-4.6')).toMatchObject({
      via: 'openrouter',
    });
  });
});

describe('native Google key resolution', () => {
  it('prefers a team Google key for a Gemini model', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-team-or' });
    await scope.saveKey({ provider: 'google', apiKey: 'google-team' });

    expect(
      await scope.resolveLlmKey('google/gemini-3.1-pro-preview')
    ).toMatchObject({
      key: 'google-team',
      source: 'team',
      via: 'google',
    });
  });

  it('leaves non-Gemini models on OpenRouter even with a Google key stored', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-team-or' });
    await scope.saveKey({ provider: 'google', apiKey: 'google-team' });

    expect(
      await scope.resolveLlmKey('anthropic/claude-sonnet-5')
    ).toMatchObject({ key: 'sk-team-or', via: 'openrouter' });
  });

  it('falls back to the platform GEMINI_API_KEY when the team has none', async () => {
    testEnv.GEMINI_API_KEY = 'platform-google';
    const scope = createApiKeysReadMethods(db, teamId);

    expect(
      await scope.resolveLlmKey('google/gemini-3-flash-preview')
    ).toMatchObject({
      key: 'platform-google',
      source: 'platform',
      via: 'google',
    });
  });

  it('falls through to OpenRouter for a Gemini model with no Google key anywhere', async () => {
    const scope = createApiKeysReadMethods(db, teamId);

    expect(
      await scope.resolveLlmKey('google/gemini-3.1-pro-preview')
    ).toMatchObject({
      key: 'platform-openrouter-key',
      via: 'openrouter',
    });
  });

  it('skips a Google key flagged invalid rather than sending it', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);
    await scope.saveKey({ provider: 'google', apiKey: 'google-team' });
    await scope.markKeyInvalid('google', 'revoked');

    expect(
      await scope.resolveLlmKey('google/gemini-3.1-pro-preview')
    ).toMatchObject({ via: 'openrouter' });
  });
});

describe('resolveOptionalKey', () => {
  it('returns undefined instead of throwing when no key exists', async () => {
    // Native-provider routing (#1216) asks "is there a key?" and falls
    // through to fal when there isn't. `resolveKey` throws there.
    testEnv.FAL_KEY = undefined;
    const scope = createApiKeysReadMethods(db, teamId);

    expect(await scope.resolveOptionalKey('fal')).toBeUndefined();
    await expect(scope.resolveKey('fal')).rejects.toThrow(
      /No API key available/
    );
  });

  it('returns undefined for xai when neither team nor platform key exists', async () => {
    const scope = createApiKeysReadMethods(db, teamId);
    expect(await scope.resolveOptionalKey('xai')).toBeUndefined();
    await expect(scope.resolveKey('xai')).rejects.toThrow(
      /No API key available/
    );
  });

  it('returns the platform key when one exists', async () => {
    const scope = createApiKeysReadMethods(db, teamId);
    expect(await scope.resolveOptionalKey('fal')).toEqual({
      key: 'platform-fal-key',
      source: 'platform',
    });
  });
});
