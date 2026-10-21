/**
 * Migrations-layout consistency checks (#897).
 *
 * Remote D1 migrations are applied by `wrangler d1 migrations apply`, which
 * reads flat `*.sql` files from `migrations_dir` and records applied ones BY
 * FILENAME in the `d1_migrations` table. Two invariants keep that safe:
 *
 *   1. Every `migrations_dir` in wrangler.jsonc (and the CI preview patch)
 *      points at `drizzle/migrations-wrangler` — the flat rendering built by
 *      scripts/flatten-migrations.ts. Pointing at the nested
 *      `drizzle/migrations` makes wrangler silently find ZERO files and
 *      "succeed" without migrating (the original deploy-button bug).
 *
 *   2. Every migration folder is `<14-digit-timestamp>_<name>/migration.sql`.
 *      The flattened filename is derived from the folder name; wrangler
 *      sorts unapplied migrations by numeric prefix and tracks applied ones
 *      by full filename — a renamed or non-numeric folder would re-order or
 *      RE-APPLY history (a data-destruction event given the D1 table-rebuild
 *      CASCADE trap, see AGENTS.md).
 *
 * Follows the wiring-consistency.test.ts pattern: cheap structural reads,
 * loud failures.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const WRANGLER_PATH = 'wrangler.jsonc';
const CI_DEPLOY_PATH = '.github/workflows/deploy-cloudflare.yml';
const MIGRATIONS_DIR = 'drizzle/migrations';
const FLAT_DIR = 'drizzle/migrations-wrangler';

describe('wrangler migrations_dir wiring', () => {
  test('every D1 binding in wrangler.jsonc uses the flattened migrations dir', () => {
    const text = readFileSync(WRANGLER_PATH, 'utf8');

    // One d1_databases block per env (default, production, test). Each must
    // carry a migrations_dir, and it must be the flat dir.
    const d1Blocks = [...text.matchAll(/"d1_databases"\s*:\s*\[/g)];
    const migrationDirs = [
      ...text.matchAll(/"migrations_dir"\s*:\s*"([^"]+)"/g),
    ].map((m) => m[1]);

    expect(d1Blocks.length).toBeGreaterThanOrEqual(3);
    expect(migrationDirs).toHaveLength(d1Blocks.length);
    for (const dir of migrationDirs) {
      expect(dir).toBe(FLAT_DIR);
    }
  });

  test('the CI preview patch re-adds the flattened migrations dir', () => {
    // The preview job REPLACES d1_databases wholesale before migrating, so
    // wrangler.jsonc's own value doesn't protect that path.
    const text = readFileSync(CI_DEPLOY_PATH, 'utf8');
    expect(text).toContain(`migrations_dir: '${FLAT_DIR}'`);
  });
});

describe('drizzle migration folder layout', () => {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'meta')
    .map((entry) => entry.name);

  test('there are migration folders at all', () => {
    expect(folders.length).toBeGreaterThan(0);
  });

  test('every folder is <14-digit-timestamp>_<name> and contains migration.sql', () => {
    for (const folder of folders) {
      expect(folder).toMatch(/^\d{14}_.+/);
      expect(existsSync(join(MIGRATIONS_DIR, folder, 'migration.sql'))).toBe(
        true
      );
    }
  });

  test('timestamps are unique (filename-keyed tracking cannot collide)', () => {
    const prefixes = folders.map((folder) => folder.slice(0, 14));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
