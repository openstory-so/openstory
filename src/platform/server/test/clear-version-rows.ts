import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  characterSheetVariants,
  characterVoiceVersions,
  locationBibleVersions,
  locationReferencePhotos,
  locationSheetVariants,
  sequenceCast,
  sequenceLocationLinks,
  sequenceStyleVersions,
} from '@/platform/server/db/schema';

/**
 * Empty every table that holds a character, location or sequence in place:
 * the #1600 version tables, the #2015 looks, the #2017 cast links, the #1695
 * location links and photos, and the sheet variants and voice versions
 * (nothing cascades from `characters` or a location). A test that wipes
 * characters, locations, sequences or teams calls this first.
 */
export async function clearVersionRows(db: Database): Promise<void> {
  await db.delete(sequenceCast);
  await db.delete(characterSheetVariants);
  await db.delete(characterVoiceVersions);
  await db.delete(characterBibleVersions);
  await db.delete(characterLookVersions);
  await db.delete(characterLooks);
  await db.delete(sequenceLocationLinks);
  await db.delete(locationReferencePhotos);
  await db.delete(locationSheetVariants);
  await db.delete(locationBibleVersions);
  await db.delete(sequenceStyleVersions);
}
