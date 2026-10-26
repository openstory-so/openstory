/**
 * The test D1 (`createTestDb`) must answer like D1. Each check runs against
 * it and against wrangler's local D1 (real workerd), so a drift in the
 * adapter fails here instead of hiding a bug the suite would have caught.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createTestDb } from './test-d1';

type Target = { d1: D1Database; close: () => Promise<void> };

async function adapter(): Promise<Target> {
  const { db, close } = await createTestDb();
  return { d1: db.$client, close };
}

async function localD1(): Promise<Target> {
  const dir = mkdtempSync(join(tmpdir(), 'openstory-d1-conformance-'));
  const configPath = join(dir, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'd1-conformance',
      compatibility_date: '2026-10-08',
      d1_databases: [
        { binding: 'DB', database_name: 'c', database_id: 'd1-conformance' },
      ],
    })
  );
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: false,
  });
  return {
    d1: proxy.env.DB,
    close: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe.each([
  ['test D1', adapter],
  ['local D1 (workerd)', localD1],
])('%s', (_name, open) => {
  let target: Target;
  const d1 = () => target.d1;

  beforeAll(async () => {
    target = await open();
    await d1().batch([
      d1().prepare('create table parent (id text primary key)'),
      d1().prepare(
        'create table child (id text primary key, parent_id text not null references parent(id), flag integer)'
      ),
    ]);
  }, 30_000);
  afterAll(() => target.close());

  it('answers a write with results, success and meta, and no rowsAffected', async () => {
    await d1().prepare("insert into parent values ('p1'), ('p2')").run();
    const result = await d1().prepare('delete from parent').run();
    expect(Object.keys(result).sort()).toEqual(['meta', 'results', 'success']);
    expect(result.meta.changes).toBe(2);
    expect(result).not.toHaveProperty('rowsAffected');
  });

  it('takes 100 bound variables and refuses 101', async () => {
    const query = (n: number) =>
      d1()
        .prepare(`select ${Array.from({ length: n }, () => '?').join(', ')}`)
        .bind(...Array.from({ length: n }, (_, i) => i))
        .raw();
    await expect(query(100)).resolves.toHaveLength(1);
    await expect(query(101)).rejects.toThrow(/too many SQL variables/);
  });

  it('keeps foreign keys on after PRAGMA foreign_keys = OFF', async () => {
    await d1().prepare('PRAGMA foreign_keys = OFF').run();
    await expect(
      d1()
        .prepare("insert into child (id, parent_id) values ('c1', 'none')")
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('refuses BEGIN', async () => {
    await expect(d1().prepare('BEGIN').run()).rejects.toThrow();
  });

  it('names a unique collision in the message', async () => {
    await d1().prepare("insert into parent values ('dup')").run();
    await expect(
      d1().prepare("insert into parent values ('dup')").run()
    ).rejects.toThrow(/UNIQUE constraint failed: parent\.id/);
  });

  it('answers first() on no rows with null', async () => {
    expect(
      await d1().prepare("select * from parent where id = 'nope'").first()
    ).toBeNull();
  });

  it('stores a bound boolean as 1 or 0, and refuses undefined', async () => {
    await d1().prepare("insert into parent values ('pb')").run();
    await d1()
      .prepare("insert into child values ('cb', 'pb', ?)")
      .bind(true)
      .run();
    expect(
      await d1().prepare("select flag from child where id = 'cb'").first('flag')
    ).toBe(1);
    expect(() => d1().prepare('select ?').bind(undefined)).toThrow();
  });

  it('rolls a whole batch back when one statement fails', async () => {
    await expect(
      d1().batch([
        d1().prepare("insert into parent values ('batch-1')"),
        d1().prepare("insert into child (id, parent_id) values ('x', 'none')"),
      ])
    ).rejects.toThrow();
    expect(
      await d1().prepare("select id from parent where id = 'batch-1'").first()
    ).toBeNull();
  });
});
