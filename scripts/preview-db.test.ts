import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
});

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));

const { fork, promote, markReady, discard } = await import('./preview-db');

const base = { revision: 2, database_id: 'base-id' };
let forked: {
  pr: number;
  revision: number;
  database_id: string;
  ready: number;
} | null;
let queries: string[];
let previewExists: boolean;
let previewHasTables: boolean;
let registrySplitAcrossPages: boolean;

function response(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
  });
}

beforeEach(() => {
  forked = null;
  base.revision = 2;
  base.database_id = 'base-id';
  queries = [];
  previewExists = true;
  previewHasTables = false;
  registrySplitAcrossPages = false;
  exec.mockReset();
  exec.mockImplementation((_bin: string, args: string[]) => {
    if (args.includes('--no-schema') || args.includes('--no-data')) {
      const output = args.find((arg) => arg.startsWith('--output='));
      if (output) writeFileSync(output.slice('--output='.length), '');
    }
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const listedName = parsed.searchParams.get('name');
      const page = Number(parsed.searchParams.get('page') ?? '1');
      if (listedName === 'openstory-preview-registry') {
        if (registrySplitAcrossPages && page === 1) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [
                { name: 'openstory-preview-registry-old', uuid: 'wrong' },
              ],
              result_info: { page: 1, per_page: 1, total_count: 2 },
            }),
            { status: 200 }
          );
        }
        return response([
          { name: 'openstory-preview-registry', uuid: 'registry-id' },
        ]);
      }
      if (listedName === 'openstory-pr-12')
        return response(
          previewExists
            ? [
                { name: 'openstory-pr-120', uuid: 'other' },
                { name: 'openstory-pr-12', uuid: 'pr-db' },
              ]
            : [{ name: 'openstory-pr-120', uuid: 'other' }]
        );
      if (url.endsWith('/pr-db') && init?.method === 'DELETE') {
        previewExists = false;
        return response(null);
      }
      if (url.endsWith('/base-id')) return response({ name: 'openstory-pr-1' });
      // Mocked D1 query payload has a known shape.
      // oxlint-disable typescript/no-unsafe-type-assertion
      const { sql, params = [] } = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}'
      ) as {
        sql: string;
        params?: (number | string)[];
      };
      // oxlint-enable typescript/no-unsafe-type-assertion
      queries.push(sql);
      let results: unknown[] = [];
      let changes = 0;
      if (sql.includes('sqlite_schema') && previewHasTables)
        results = [{ name: 'teams' }];
      if (sql.includes('SELECT revision, database_id FROM preview_base'))
        results = [{ ...base }];
      if (sql.includes('FROM preview_forks WHERE pr') && forked)
        results = [{ ...forked }];
      if (sql.startsWith('INSERT INTO preview_forks')) {
        forked = {
          pr: Number(params[0]),
          revision: Number(params[1]),
          database_id: String(params[2]),
          ready: 0,
        };
        changes = 1;
      }
      if (
        sql.startsWith('DELETE FROM preview_forks') &&
        forked?.pr === params[0]
      ) {
        forked = null;
        changes = 1;
      }
      if (
        sql.startsWith('UPDATE preview_forks') &&
        forked &&
        forked.pr === params[0] &&
        forked.database_id === params[1]
      ) {
        forked.ready = 1;
        changes = 1;
      }
      if (
        sql.startsWith('UPDATE preview_base') &&
        base.revision === params[1]
      ) {
        base.revision++;
        base.database_id = String(params[0]);
        changes = 1;
      }
      return response([{ success: true, results, meta: { changes } }]);
    })
  );
});

describe('preview D1 lineage', () => {
  it('records an occupied database instead of importing into it', async () => {
    previewHasTables = true;
    await fork(12, 'pr-db');
    expect(exec).not.toHaveBeenCalled();
    expect(forked).toEqual({
      pr: 12,
      revision: 2,
      database_id: 'pr-db',
      ready: 0,
    });
  });

  it('ignores a name-search hit that is not the registry', async () => {
    registrySplitAcrossPages = true;
    await fork(12, 'pr-db');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/registry-id/query'),
      expect.anything()
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/wrong/'),
      expect.anything()
    );
  });

  it('forks only once, preserving the PR database on redeploy', async () => {
    await fork(12, 'pr-db');
    expect(exec).toHaveBeenCalledTimes(4); // schema/data export and import
    expect(forked).toEqual({
      pr: 12,
      revision: 2,
      database_id: 'pr-db',
      ready: 0,
    });
    await fork(12, 'pr-db');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('promotes a matching fork and treats retries as successful', async () => {
    forked = { pr: 12, revision: 2, database_id: 'pr-db', ready: 1 };
    await promote(12);
    expect(base).toEqual({ revision: 3, database_id: 'pr-db' });
    await promote(12);
    expect(
      queries.filter((sql) => sql.startsWith('UPDATE preview_base'))
    ).toHaveLength(1);
  });

  it('preserves the PR database if another merge advanced the base', async () => {
    forked = { pr: 12, revision: 1, database_id: 'pr-db', ready: 1 };
    await expect(promote(12)).rejects.toThrow('Preview DB conflict');
    expect(base.database_id).toBe('base-id');
    expect(queries).not.toContainEqual(
      expect.stringMatching(/^UPDATE preview_base/)
    );
  });

  it('refuses to promote a preview with no completed fork', async () => {
    await expect(promote(12)).rejects.toThrow('no completed fork');
  });

  it('refuses to promote a preview that never deployed', async () => {
    forked = { pr: 12, revision: 2, database_id: 'pr-db', ready: 0 };
    await expect(promote(12)).rejects.toThrow('never deployed');
    await markReady(12, 'pr-db');
    await promote(12);
    expect(base.database_id).toBe('pr-db');
  });

  it('discards an unmerged PR and lets reopening fork the current base', async () => {
    forked = { pr: 12, revision: 1, database_id: 'pr-db', ready: 1 };
    await discard(12);
    expect(previewExists).toBe(false);
    expect(forked).toBeNull();
    await fork(12, 'new-pr-db');
    expect(forked).toMatchObject({ revision: 2, database_id: 'new-pr-db' });
  });

  it('does not clear the record or delete the current base', async () => {
    forked = { pr: 12, revision: 2, database_id: 'pr-db', ready: 1 };
    base.database_id = 'pr-db';
    await expect(discard(12)).rejects.toThrow('active preview base');
    expect(previewExists).toBe(true);
    expect(forked).not.toBeNull();
  });
});
