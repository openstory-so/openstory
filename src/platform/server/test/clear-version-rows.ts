import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  locationBibleVersions,
  sequenceCast,
  sequenceCastLooks,
  sequenceStyleVersions,
} from '@/platform/server/db/schema';

/**
 * Empty the #1600 version tables, the #2015 looks and the #2017 cast links.
 * They RESTRICT their parents' delete, so a
 * test that wipes characters, locations, sequences or teams calls this first.
 */
export async function clearVersionRows(db: Database): Promise<void> {
  await db.delete(sequenceCastLooks);
  await db.delete(sequenceCast);
  await db.delete(characterBibleVersions);
  await db.delete(characterLookVersions);
  await db.delete(characterLooks);
  await db.delete(locationBibleVersions);
  await db.delete(sequenceStyleVersions);
}
