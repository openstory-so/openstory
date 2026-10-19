/**
 * Scoped `stitches` rows (#2127). A team creates and publishes; anyone with
 * the id reads a published row, through the unscoped `createPublicStitchReads`
 * the composition root exposes as `getPublicStitch` — the page at
 * /stitch/<id> has no team.
 */

import type { Database } from '@/platform/server/db/client';
import { stitches, type Stitch } from '@/platform/server/db/schema';
import type { StitchCut } from '@/stitches/cut';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

export function createStitchesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    /**
     * Insert a cut whose media URLs are already the stored form. The caller
     * mints the id first (`generateId`), since the stored URLs carry it.
     * `publishedAt` is null while the files are still to be uploaded.
     */
    create: async (input: {
      id: string;
      cut: StitchCut;
      publishedAt: Date | null;
    }): Promise<Stitch> => {
      const rows = await db
        .insert(stitches)
        .values({
          id: input.id,
          teamId,
          userId,
          cut: input.cut,
          publishedAt: input.publishedAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('stitch insert returned no row');
      return row;
    },

    getById: async (id: string): Promise<Stitch | null> => {
      const rows = await db
        .select()
        .from(stitches)
        .where(and(eq(stitches.id, id), eq(stitches.teamId, teamId)))
        .limit(1);
      return rows[0] ?? null;
    },

    /** Mark the row published; null when it is not this team's or already is. */
    publish: async (id: string): Promise<Stitch | null> => {
      const rows = await db
        .update(stitches)
        .set({ publishedAt: new Date() })
        .where(
          and(
            eq(stitches.id, id),
            eq(stitches.teamId, teamId),
            isNull(stitches.publishedAt)
          )
        )
        .returning();
      return rows[0] ?? null;
    },
  };
}

export function createPublicStitchReads(db: Database) {
  return {
    /** A published stitch only: an unpublished one is not a page yet. */
    getById: async (id: string): Promise<Stitch | null> => {
      const rows = await db
        .select()
        .from(stitches)
        .where(and(eq(stitches.id, id), isNotNull(stitches.publishedAt)))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
