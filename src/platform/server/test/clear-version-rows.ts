import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  characterSheetVariants,
  characterVoiceVersions,
  locationBibleVersions,
  sequenceCast,
  sequenceCastLooks,
  sequenceStyleVersions,
} from '@/platform/server/db/schema';

/**
 * Empty every table that holds a character, location or sequence in place:
 * the #1600 version tables, the #2015 looks, the #2017 cast links, and the
 * sheet variants and voice versions (nothing cascades from `characters`). A
 * test that wipes characters, locations, sequences or teams calls this first.
 */
export async function clearVersionRows(db: Database): Promise<void> {
  await db.delete(sequenceCastLooks);
  await db.delete(sequenceCast);
  await db.delete(characterSheetVariants);
  await db.delete(characterVoiceVersions);
  await db.delete(characterBibleVersions);
  await db.delete(characterLookVersions);
  await db.delete(characterLooks);
  await db.delete(locationBibleVersions);
  await db.delete(sequenceStyleVersions);
}
