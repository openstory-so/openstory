#!/usr/bin/env bun
/**
 * Trim the production BytePlus ACR pool: delete every Ark asset whose ledger
 * row has NO live lease, provider first and ledger row second, so no
 * in-flight Seedance job loses its `asset://` and no ledger row points at a
 * dead asset in between.
 *
 * Why: the pool filled to 50 while `BYTEPLUS_ASSET_SLOTS` was 50; lowering
 * the cap to 45 never shrinks it, because the claim path evicts in place.
 * This is the manual trim. The pool refills on demand at
 * `BYTEPLUS_ASSET_WRITE_QPM` (3/min on Entry).
 *
 *   bun scripts/trim-byteplus-assets.ts            # plan only
 *   bun scripts/trim-byteplus-assets.ts --apply    # delete
 *   bun scripts/trim-byteplus-assets.ts --keep 10  # spare the 10 most recently used
 *
 * Ledger reads/writes go through `wrangler d1 execute --env production
 * --remote` (the only laptop path to prod D1). Ark deletes use the IAM keys
 * in `.env.local` — the same account production registers into.
 */
import { execFileSync } from 'node:child_process';
import { deleteAsset } from '@/models/server/byteplus-assets';
import { bytePlusOpenApiConfig } from '@/models/server/byteplus-config';

type Row = { id: string; identity: string; asset_id: string; slot: string };
type Envelope = { results?: unknown[]; success?: boolean };

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const keepFlag = argv.indexOf('--keep');
const keep =
  keepFlag === -1
    ? 0
    : Math.max(0, Number.parseInt(argv[keepFlag + 1] ?? '0', 10) || 0);

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null;
}

function d1<T>(sql: string): T[] {
  // One line: wrangler mangles a multi-line --command. Errors land on stdout.
  const out = execFileSync(
    'bunx',
    [
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--env',
      'production',
      '--remote',
      '--json',
      '--command',
      sql.replace(/\s+/g, ' ').trim(),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')));
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!isEnvelope(first) || first.success !== true) {
    throw new Error(`D1 statement did not succeed: ${out.slice(0, 400)}`);
  }
  // Rows are whatever the SELECT named; the caller's T is its column list.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- D1 rows are untyped JSON
  return (first.results ?? []) as T[];
}

const config = bytePlusOpenApiConfig();
if (!config) {
  console.error('BYTEPLUS_ACCESS_KEY / BYTEPLUS_SECRET_KEY missing');
  process.exit(1);
}

// Same predicate as the pool's `unleased(now)`: no lease on this identity
// that expires in the future. Reservations (asset_id NULL) are never touched.
const candidates = d1<Row>(`
  SELECT a.id, a.identity, a.asset_id, a.slot
  FROM byteplus_assets a
  WHERE a.asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM byteplus_asset_leases l
      WHERE l.identity = a.identity AND l.expires_at > strftime('%s', 'now')
    )
  ORDER BY a.last_used_at DESC
`);
const totals = d1<{ total: number; leased: number }>(`
  SELECT count(*) AS total,
    sum(EXISTS (SELECT 1 FROM byteplus_asset_leases l
                WHERE l.identity = byteplus_assets.identity
                  AND l.expires_at > strftime('%s', 'now'))) AS leased
  FROM byteplus_assets
`)[0] ?? { total: 0, leased: 0 };

const victims = candidates.slice(keep);
console.log(
  `ledger rows: ${totals.total}, live-leased: ${totals.leased}, unleased: ${candidates.length}, keeping ${keep}, deleting ${victims.length}`
);
if (!apply) {
  for (const row of victims) {
    console.log(`  would delete ${row.asset_id} (${row.slot})`);
  }
  console.log('dry run — pass --apply to delete');
  process.exit(0);
}

let deleted = 0;
let failed = 0;
for (const row of victims) {
  try {
    // Provider first: a row that outlives its asset is forgotten by the
    // hourly sweep; an asset that outlives its row is only reclaimed after
    // 45 minutes. Both are recoverable; the reverse order is not.
    await deleteAsset(config, row.asset_id);
    d1(
      `DELETE FROM byteplus_assets WHERE id = '${row.id}' AND asset_id = '${row.asset_id}'`
    );
    deleted += 1;
    console.log(`deleted ${row.asset_id} (${row.slot})`);
  } catch (error) {
    failed += 1;
    console.error(
      `failed ${row.asset_id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
console.log(`done: deleted ${deleted}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
