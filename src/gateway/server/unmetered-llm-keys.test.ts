/**
 * After one-place charging (#2437), an LLM key with no meter is never charged.
 * These are the only files that can produce one; any other file that needs a
 * platform LLM key goes through `scopedDb.apiKeys`, which meters it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

/** Files that may name an uncharged reason, mint a platform key, or copy a meter across keys. */
const UNMETERED_ALLOWLIST = [
  // Defines them.
  'src/models/server/create-adapter.ts',
  // Unwrapped resolver; only `scoped.ts` builds it, inside `withTextGateway`.
  'src/models/server/db/api-keys.ts',
  // Puts the meter on.
  'src/gateway/server/text.ts',
  // The Google re-run of a call already marked uncharged.
  'src/models/server/llm-client.ts',
  // Its own per-provider `OWN_KEY` table (media routing), not the charging mode.
  'src/gateway/server/route.ts',
];

/** Files that may build the unwrapped `apiKeys` methods. */
const API_KEYS_FACTORY_ALLOWLIST = ['src/platform/server/db/scoped.ts'];

/** Any uncharged reason by name or literal, a bare `uncharged:`, or a meter copied from another key. */
const UNCHARGED =
  /\bgetPlatformLlmKey\b|(?<!['"])\b(OWN_KEY|NO_ORGANIZATION|UNFUNDED_GENERATION)\b(?!['"])|'(own key|no organization|unfunded generation)'|\buncharged\s*:|\bmeter\s*:\s*[\w.?]*[kK]ey\w*\.meter\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|stories)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const files = sourceFiles(join(ROOT, 'src')).map((path) => ({
  path: relative(ROOT, path),
  source: readFileSync(path, 'utf8'),
}));

describe('unmetered LLM keys', () => {
  it('only the allowlisted files can mint a platform LLM key with no meter', () => {
    const minting = files
      .filter(({ source }) => UNCHARGED.test(source))
      .map(({ path }) => path)
      .sort();
    expect(minting).toEqual([...UNMETERED_ALLOWLIST].sort());
  });

  it('the pattern catches each way round the allowlist', () => {
    for (const evasion of [
      'const k = { ...platform, meter: OWN_KEY };',
      "const k = { ...platform, meter: { uncharged: 'own key' } };",
      'const k = { ...platform, meter: { uncharged: reason } };',
      'const k = { ...platform, meter: otherKey.meter };',
    ]) {
      expect(UNCHARGED.test(evasion), evasion).toBe(true);
    }
  });

  it('a platform key cannot carry own key, nor an organization key a meter (type-level)', () => {
    // @ts-expect-error -- own key is for an organization's key only.
    const platform: ResolvedLlmKey = {
      key: 'k',
      source: 'platform',
      via: 'openrouter',
      meter: { uncharged: 'own key' },
    };
    // @ts-expect-error -- an organization's key is never metered or marked as a platform key.
    const own: ResolvedLlmKey = {
      key: 'k',
      source: 'organization',
      via: 'openrouter',
      meter: { uncharged: 'no organization' },
    };
    expect([platform.source, own.source]).toEqual(['platform', 'organization']);
  });

  it('only scoped.ts builds the unwrapped apiKeys, and it wraps them in withTextGateway', () => {
    const building = files
      .filter(
        ({ path, source }) =>
          path !== 'src/models/server/db/api-keys.ts' &&
          /\bcreateApiKeys(Read)?Methods\(/.test(source)
      )
      .map(({ path }) => path);
    expect(building).toEqual(API_KEYS_FACTORY_ALLOWLIST);
    const scoped = files.find(
      ({ path }) => path === 'src/platform/server/db/scoped.ts'
    );
    expect(scoped?.source).toMatch(
      /withTextGateway\(\s*createApiKeysMethods\(/
    );
  });
});
