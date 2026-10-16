/**
 * Scoped `stitches` rows (#2127). A team creates; anyone with the id reads,
 * through the unscoped `createPublicStitchReads` the composition root exposes
 * as `getPublicStitch` — the page at /stitch/<id> has no team.
 */

import type { Database } from '@/platform/server/db/client';
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
     * Insert a cut whose media URLs are already the stored form. The caller
     * mints the id first (`generateId`), since the stored URLs carry it.
     */
    create: async (input: { id: string; cut: StitchCut }): Promise<Stitch> => {
      const rows = await db
        .insert(stitches)
        .values({ id: input.id, teamId, userId, cut: input.cut })
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
