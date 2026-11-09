import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@/platform/server/db/client';
import { createTestDb } from '@/platform/server/db/test-d1';
import { stampInputHash } from '@/shots/input-hash';
import { createInputManifestsMethods } from './input-manifests';

let db: Database;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});
afterAll(() => closeDb());

describe('inputManifests (#2344)', () => {
  it('records more hashes than fit one D1 statement, once', async () => {
    const methods = createInputManifestsMethods(db);
    const stamps = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        stampInputHash({ artifact: 'test', i })
      )
    );
    await methods.record(stamps);
    await methods.record(stamps);
    const stored = await methods.getByHashes([
      ...stamps.map((s) => s.hash),
      null,
    ]);
    expect(stored.size).toBe(40);
    expect([...stored.values()][0]).toEqual({
      artifact: expect.any(String),
      i: expect.any(String),
    });
  });
});
