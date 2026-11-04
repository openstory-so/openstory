/**
 * Scoped Library Sub-module
 * Organization-scoped library resource aggregation (styles, vfx, audio).
 */

import { asc, desc, eq } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { audio, styles, vfx } from '@/platform/server/db/schema';
import type { Audio, Style, Vfx } from '@/platform/server/db/schema';

export function createLibraryMethods(db: Database, organizationId: string) {
  return {
    getAll: async (): Promise<{
      styles: Style[];
      vfx: Vfx[];
      audio: Audio[];
    }> => {
      const [stylesList, vfxList, audioList] = await Promise.all([
        db
          .select()
          .from(styles)
          .where(eq(styles.organizationId, organizationId))
          .orderBy(
            asc(styles.sortOrder),
            desc(styles.usageCount),
            asc(styles.createdAt)
          ),
        db
          .select()
          .from(vfx)
          .where(eq(vfx.organizationId, organizationId))
          .orderBy(desc(vfx.createdAt)),
        db
          .select()
          .from(audio)
          .where(eq(audio.organizationId, organizationId))
          .orderBy(desc(audio.createdAt)),
      ]);

      return { styles: stylesList, vfx: vfxList, audio: audioList };
    },
  };
}
