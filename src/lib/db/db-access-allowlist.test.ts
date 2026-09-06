/**
 * Pins who may reach the raw D1 handle and who may mint a ScopedDb.
 *
 * The `no-restricted-imports` rule in `.oxlintrc.json` says the same thing,
 * but it matches the literal specifier: `import { getDb } from './client-d1'`
 * or `from '../db/scoped'` walks straight past it. This test resolves every
 * value import (alias, relative, bare) to the file it lands on, so the
 * allowlists below are the whole story. Keep the two lists in sync with the
 * db-access overrides at the bottom of `.oxlintrc.json`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = resolve(__dirname, '..', '..', '..');

/** Files that may value-import the raw handle (`#db-client` or a client-*.ts). */
const RAW_DB_ALLOWLIST = [
  'src/lib/db/scoped.ts',
  'src/lib/db/client.ts',
  'src/lib/auth/config.ts',
  'src/lib/cron/reconcile-all.ts',
  'src/lib/cron/reconcile-fal-billing.ts',
  'src/lib/cron/refresh-fal-pricing.ts',
  'src/lib/ai/fal-pricing-live.ts',
  'src/lib/db/seed-model-pricing.ts',
  'src/lib/test/seed.ts',
];

/** Files that may value-import `createScopedDb` / `createSystemAdminScopedDb`. */
const SCOPED_FACTORY_ALLOWLIST = [
  'src/functions/middleware.ts',
  'src/functions/stripe-webhook-middleware.ts',
  'src/lib/workflow/base-workflow.ts',
];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec|stories)\./.test(p)) yield p;
  }
}

const IMPORT_RE = /^import\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;

function importsOf(file: string): { names: string; spec: string }[] {
  const out: { names: string; spec: string }[] = [];
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
    out.push({ names: m[1] ?? '', spec: m[2] ?? '' });
  }
  return out;
}

const isRawDbSpec = (from: string, spec: string) => {
  if (spec === '#db-client') return true;
  const target = spec.startsWith('.')
    ? relative(SRC, resolve(from, '..', spec))
    : spec.replace(/^@\//, 'src/');
  return /^src\/lib\/db\/client(-d1|-node|-stub)?$/.test(target);
};

const isScopedFactorySpec = (from: string, spec: string) =>
  spec === '@/lib/db/scoped' ||
  (spec.startsWith('.') &&
    relative(SRC, resolve(from, '..', spec)) === 'src/lib/db/scoped');

describe('db access allowlists', () => {
  const rawDb: string[] = [];
  const factory: string[] = [];
  for (const file of walk(join(SRC, 'src'))) {
    const rel = relative(SRC, file);
    for (const { names, spec } of importsOf(file)) {
      if (isRawDbSpec(file, spec)) rawDb.push(rel);
      if (
        isScopedFactorySpec(file, spec) &&
        /\bcreate(SystemAdmin)?ScopedDb\b/.test(names)
      ) {
        factory.push(rel);
      }
    }
  }

  test('only the allowlisted files value-import the raw D1 handle', () => {
    expect([...new Set(rawDb)].sort()).toEqual([...RAW_DB_ALLOWLIST].sort());
  });

  test('only the middlewares and the workflow base mint a ScopedDb', () => {
    expect([...new Set(factory)].sort()).toEqual(
      [...SCOPED_FACTORY_ALLOWLIST].sort()
    );
  });
});
