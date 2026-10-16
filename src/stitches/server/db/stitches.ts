/**
 * Scoped `stitches` rows (#2127). A team creates; anyone with the id reads,
 * through the unscoped `createPublicStitchReads` the composition root exposes
 * as `getPublicStitch` — the page at /stitch/<id> has no team.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { stitches, type Stitch } from '@/platform/server/db/schema';
import type { StitchCut } from '@/stitches/cut';
import { eq } from 'drizzle-orm';

export function createStitchesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    /**
     * Insert a cut whose media URLs are already the stored form. The id is
     * minted here and handed to `storedCut` first, so the URLs can carry it.
     */
    create: async (storedCut: (id: string) => StitchCut): Promise<Stitch> => {
      const id = generateId();
      const rows = await db
        .insert(stitches)
        .values({ id, teamId, userId, cut: storedCut(id) })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('stitch insert returned no row');
      return row;
    },
  };
}

export function createPublicStitchReads(db: Database) {
  return {
    getById: async (id: string): Promise<Stitch | null> => {
      const rows = await db
        .select()
        .from(stitches)
        .where(eq(stitches.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
