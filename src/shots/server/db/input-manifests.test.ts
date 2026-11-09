import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@/platform/server/db/client';
import { createTestDb } from '@/platform/server/db/test-d1';
import { sha256Hex, stampInputHash } from '@/shots/input-hash';
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
    const hashes = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        stampInputHash({ artifact: 'test', i })
      )
    );
    await methods.record(hashes);
    await methods.record(hashes);
    const stored = await methods.getByHashes([...hashes, null]);
    expect(stored.size).toBe(40);
    expect([...stored.values()][0]).toEqual({
      artifact: expect.any(String),
      i: expect.any(String),
    });
  });

  it('refuses a hash with no manifest in memory', async () => {
    const methods = createInputManifestsMethods(db);
    const legacy = await sha256Hex({ artifact: 'legacy' });
    await expect(methods.record([legacy])).rejects.toThrow(
      /no manifest in memory/
    );
  });
});
