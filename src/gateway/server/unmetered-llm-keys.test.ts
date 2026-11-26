/**
 * After one-place charging (#2437), an LLM key with no meter is never charged.
 * These are the only files that can produce one; any other file that needs a
 * platform LLM key goes through `scopedDb.apiKeys`, which meters it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

/** Files that may mint a platform LLM key with no meter (`getPlatformLlmKey`, `NO_ORGANIZATION`). */
const UNMETERED_ALLOWLIST = [
  // Defines them.
  'src/models/server/create-adapter.ts',
  // Unwrapped resolver; only `scoped.ts` builds it, inside `withTextGateway`.
  'src/models/server/db/api-keys.ts',
  // Puts the meter on.
  'src/gateway/server/text.ts',
  // A durable call with no scopedDb: no organization to charge.
  'src/models/server/llm-call-helper.ts',
  // The Google re-run of a call already marked `no organization`.
  'src/models/server/llm-client.ts',
];

/** Files that may build the unwrapped `apiKeys` methods. */
const API_KEYS_FACTORY_ALLOWLIST = ['src/platform/server/db/scoped.ts'];

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
      .filter(({ source }) =>
        /\bgetPlatformLlmKey\b|(?<!['"])\bNO_ORGANIZATION\b(?!['"])|uncharged:\s*'no organization'/.test(
          source
        )
      )
      .map(({ path }) => path)
      .sort();
    expect(minting).toEqual([...UNMETERED_ALLOWLIST].sort());
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
