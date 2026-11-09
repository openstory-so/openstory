/**
 * Content-addressed input manifests (#2344): what a hash read, by the hash.
 * A stamp site records right after computing; a verdict reads the stored
 * manifest for the artifact's hash and diffs it against the live one.
 */

import { inArray } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { inputManifests } from '@/platform/server/db/schema';
import { selectInChunks } from '@/platform/server/db/select-in-chunks';
import type { InputManifest, Stamped } from '@/shots/input-hash';

/** Rows per insert: 3 bindings each under D1's 100-variable cap. */
const INSERT_CHUNK = 33;

/** Insert-or-ignore each stamp's manifest under its hash. */
export async function recordInputManifests(
  db: Database,
  stamps: readonly (Stamped | null | undefined)[]
): Promise<void> {
  const byHash = new Map<string, InputManifest>();
  for (const stamp of stamps) if (stamp) byHash.set(stamp.hash, stamp.manifest);
  const rows = [...byHash].map(([hash, manifest]) => ({ hash, manifest }));
  const inserts = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    inserts.push(
      db
        .insert(inputManifests)
        .values(rows.slice(i, i + INSERT_CHUNK))
        .onConflictDoNothing()
    );
  }
  const [first, ...rest] = inserts;
  if (!first) return;
  if (rest.length === 0) {
    await first;
    return;
  }
  await db.batch([first, ...rest]);
}

export function createInputManifestsMethods(db: Database) {
  return {
    record: (stamps: readonly (Stamped | null | undefined)[]) =>
      recordInputManifests(db, stamps),
    /** Stored manifests by hash; absent keys were stamped before manifests. */
    getByHashes: async (
      hashes: readonly (string | null | undefined)[]
    ): Promise<Map<string, InputManifest>> => {
      const ids = [...new Set(hashes)].filter((h): h is string => !!h);
      const rows = await selectInChunks(db, ids, 100, (chunk) =>
        db
          .select()
          .from(inputManifests)
          .where(inArray(inputManifests.hash, chunk))
      );
      return new Map(rows.map((row) => [row.hash, row.manifest]));
    },
  };
}
