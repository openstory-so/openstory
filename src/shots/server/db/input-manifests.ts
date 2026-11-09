/**
 * Content-addressed input manifests (#2344): what a hash read, by the hash.
 * A stamp site records right after computing; a verdict reads the stored
 * manifest for the artifact's hash and diffs it against the live one.
 */

import { inArray } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { inputManifests } from '@/platform/server/db/schema';
import { selectInChunks } from '@/platform/server/db/select-in-chunks';
import { getLogger } from '@/platform/logger';
import { manifestOfHash, type InputManifest } from '@/shots/input-hash';

const logger = getLogger(['openstory', 'shots', 'input-manifests']);

/**
 * Insert-or-ignore the manifest of each hash this isolate just stamped. A
 * hash with no manifest in memory was computed elsewhere (or evicted): the
 * artifact then falls back to the timestamp guess, and the log says so.
 */
export async function recordInputManifests(
  db: Database,
  hashes: readonly (string | null | undefined)[]
): Promise<void> {
  const rows: { hash: string; manifest: InputManifest }[] = [];
  for (const hash of new Set(hashes)) {
    if (!hash) continue;
    const manifest = manifestOfHash(hash);
    if (manifest) rows.push({ hash, manifest });
    else logger.warn('no manifest in memory for input hash', { hash });
  }
  if (rows.length === 0) return;
  await db.insert(inputManifests).values(rows).onConflictDoNothing();
}

export function createInputManifestsMethods(db: Database) {
  return {
    record: (hashes: readonly (string | null | undefined)[]) =>
      recordInputManifests(db, hashes),
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
