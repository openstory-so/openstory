/**
 * PR-preview D1 lineage. The registry is control-plane data only; the base is
 * the last successfully promoted PR database, which stays intact after close.
 * No production database is ever read or written here.
 *
 * CI serializes fork and promotion jobs (cf-preview-db). Do not run concurrent
 * invocations outside that lock: D1's query API has no cross-request lock.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  foreignKeysFromSchema,
  reorderPreviewDump,
} from './reorder-preview-dump';

export const REGISTRY_NAME = 'openstory-preview-registry';

export function canPromote(
  forkRevision: number,
  baseRevision: number
): boolean {
  return forkRevision === baseRevision;
}

type QueryResult = {
  results: Record<string, unknown>[];
  meta: { changes: number };
  success: boolean;
};
type Base = { revision: number; database_id: string | null };
type Fork = { revision: number; database_id: string; ready: number };

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const root = account
  ? `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`
  : '';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    ...init,
    headers,
  });
  // Cloudflare's HTTP response has no static type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const body = (await response.json()) as {
    success: boolean;
    errors?: unknown;
    result: T;
  };
  if (!response.ok || !body.success) {
    throw new Error(
      `Cloudflare D1 API ${response.status}: ${JSON.stringify(body.errors)}`
    );
  }
  return body.result;
}

async function query<T>(
  db: string,
  sql: string,
  params: (string | number)[] = []
): Promise<T[]> {
  const result = await api<QueryResult[]>(`${root}/${db}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql, params }),
  });
  if (!result[0]?.success) throw new Error(`D1 query failed: ${sql}`);
  // SQL projections are declared by each call site.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result[0].results as T[];
}

async function registry(): Promise<string> {
  const listed = await api<{ uuid: string }[]>(`${root}?name=${REGISTRY_NAME}`);
  let id = listed[0]?.uuid;
  if (!id) {
    const created = await api<{ uuid: string }>(root, {
      method: 'POST',
      body: JSON.stringify({ name: REGISTRY_NAME }),
    });
    id = created.uuid;
  }
  await query(
    id,
    'CREATE TABLE IF NOT EXISTS preview_base (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, database_id TEXT)'
  );
  await query(
    id,
    'INSERT OR IGNORE INTO preview_base (id, revision, database_id) VALUES (1, 0, NULL)'
  );
  await query(
    id,
    'CREATE TABLE IF NOT EXISTS preview_forks (pr INTEGER PRIMARY KEY, revision INTEGER NOT NULL, database_id TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0)'
  );
  return id;
}

async function baseOf(db: string): Promise<Base> {
  const [base] = await query<Base>(
    db,
    'SELECT revision, database_id FROM preview_base WHERE id = 1'
  );
  if (!base) throw new Error('Preview base registry is empty');
  return base;
}

function wrangler(args: string[]): void {
  execFileSync('bunx', ['wrangler', ...args], { stdio: 'inherit' });
}

export async function fork(pr: number, databaseId: string): Promise<void> {
  const db = await registry();
  const [existing] = await query<Fork>(
    db,
    'SELECT revision, database_id FROM preview_forks WHERE pr = ?',
    [pr]
  );
  if (existing) {
    if (existing.database_id !== databaseId)
      throw new Error(
        `PR ${pr} database changed; refusing to reuse its fork record`
      );
    console.log(
      `PR ${pr} already forked from revision ${existing.revision}; retaining its data`
    );
    return;
  }

  const base = await baseOf(db);
  if (base.database_id) {
    const source = await api<{ name: string }>(`${root}/${base.database_id}`);
    const dir = mkdtempSync(path.join(tmpdir(), 'openstory-preview-db-'));
    try {
      const schema = path.join(dir, 'schema.sql');
      const data = path.join(dir, 'data.sql');
      const ordered = path.join(dir, 'ordered.sql');
      wrangler([
        'd1',
        'export',
        source.name,
        '--remote',
        '--skip-confirmation',
        '--no-data',
        `--output=${schema}`,
      ]);
      wrangler([
        'd1',
        'export',
        source.name,
        '--remote',
        '--skip-confirmation',
        '--no-schema',
        `--output=${data}`,
      ]);
      const edges = foreignKeysFromSchema(readFileSync(schema, 'utf8'));
      writeFileSync(
        ordered,
        reorderPreviewDump(readFileSync(data, 'utf8'), edges)
      );
      // Schema + migration history must both be cloned. Parent-first data
      // survives D1's multi-transaction import of large SQL files (#897).
      wrangler([
        'd1',
        'execute',
        `openstory-pr-${pr}`,
        '--remote',
        '--yes',
        `--file=${schema}`,
      ]);
      wrangler([
        'd1',
        'execute',
        `openstory-pr-${pr}`,
        '--remote',
        '--yes',
        `--file=${ordered}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  await query(
    db,
    'INSERT INTO preview_forks (pr, revision, database_id) VALUES (?, ?, ?)',
    [pr, base.revision, databaseId]
  );
  console.log(`Forked PR ${pr} from preview base revision ${base.revision}`);
}

export async function promote(pr: number): Promise<void> {
  const db = await registry();
  const [forked] = await query<Fork>(
    db,
    'SELECT revision, database_id, ready FROM preview_forks WHERE pr = ?',
    [pr]
  );
  if (!forked)
    throw new Error(`PR ${pr} has no completed fork; retaining its database`);
  if (forked.ready !== 1)
    throw new Error(
      `PR ${pr} preview was never deployed successfully; retaining its database`
    );
  const current = await baseOf(db);
  if (current.database_id === forked.database_id) {
    console.log(`PR ${pr} already promoted`);
    return;
  }
  if (!canPromote(forked.revision, current.revision)) {
    throw new Error(
      `Preview DB conflict: PR ${pr} forked revision ${forked.revision}, but the base is now revision ${current.revision}. The PR database is preserved; reconcile manually before promoting.`
    );
  }
  // Serialized by CI. A conditional UPDATE guards accidental duplicate runs.
  const result = await api<QueryResult[]>(`${root}/${db}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: 'UPDATE preview_base SET revision = revision + 1, database_id = ? WHERE id = 1 AND revision = ?',
      params: [forked.database_id, forked.revision],
    }),
  });
  if (!result[0]?.success || result[0].meta.changes !== 1) {
    throw new Error(
      'Preview DB promotion lost a race; PR database is preserved'
    );
  }
  console.log(
    `Promoted PR ${pr} as preview base revision ${current.revision + 1}`
  );
}

export async function markReady(pr: number, databaseId: string): Promise<void> {
  const db = await registry();
  const rows = await api<QueryResult[]>(`${root}/${db}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: 'UPDATE preview_forks SET ready = 1 WHERE pr = ? AND database_id = ?',
      params: [pr, databaseId],
    }),
  });
  if (!rows[0]?.success || rows[0].meta.changes !== 1)
    throw new Error(`Cannot mark PR ${pr} preview ready: missing fork record`);
}

async function main(): Promise<void> {
  const [mode, rawPr, databaseId] = process.argv.slice(2);
  const pr = Number(rawPr);
  if (!account || !token || !Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(
      'Usage: preview-db.ts fork <pr> <database-uuid> | ready <pr> <database-uuid> | promote <pr> (requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)'
    );
  }
  if (mode === 'fork' && databaseId && /^[0-9a-f-]{36}$/.test(databaseId)) {
    await fork(pr, databaseId);
  } else if (mode === 'promote' && !databaseId) {
    await promote(pr);
  } else if (
    mode === 'ready' &&
    databaseId &&
    /^[0-9a-f-]{36}$/.test(databaseId)
  ) {
    await markReady(pr, databaseId);
  } else {
    throw new Error(
      'Usage: preview-db.ts fork <pr> <database-uuid> | ready <pr> <database-uuid> | promote <pr>'
    );
  }
}

if (import.meta.main) await main();
