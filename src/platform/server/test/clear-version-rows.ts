import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  locationBibleVersions,
  sequenceStyleVersions,
} from '@/platform/server/db/schema';

/**
 * Empty the #1600 version tables. They RESTRICT their parents' delete, so a
 * test that wipes characters, locations, sequences or teams calls this first.
 */
export async function clearVersionRows(db: Database): Promise<void> {
  await db.delete(characterBibleVersions);
  await db.delete(locationBibleVersions);
  await db.delete(sequenceStyleVersions);
}
