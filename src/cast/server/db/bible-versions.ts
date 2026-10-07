/**
 * Bible history (#1600): the one resolver for a character's or sequence
 * location's bible, and the diff that names what an edit changed.
 *
 * The bible lives in `character_bible_versions` / `location_bible_versions`;
 * the parent's `selectedBibleVersionId` names the live row. Every scoped read
 * joins that row and re-adds the fields under their old names. A parent with
 * no version — written by a worker older than #1600, during the deploy window
 * — reads its legacy columns instead. That fallback is the only reader of
 * those columns.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { ConflictError } from '@/platform/errors';
import {
  CHARACTER_BIBLE_FIELDS,
  LOCATION_BIBLE_FIELDS,
  characterBibleVersions as cbv,
  characters,
  locationBibleVersions as lbv,
  sequenceLocations,
} from '@/platform/server/db/schema';
import type {
  CharacterBible,
  LocationBible,
} from '@/platform/server/db/schema';

/** The version's value, or the legacy column's when the parent has none. */
const live = (
  versionId: AnySQLiteColumn,
  version: AnySQLiteColumn,
  legacy: AnySQLiteColumn
) => sql`CASE WHEN ${versionId} IS NULL THEN ${legacy} ELSE ${version} END`;

/** Select fields: a character's bible, resolved. Needs the version joined. */
export const characterBibleColumns = {
  name: sql<string>`${live(cbv.id, cbv.name, characters.legacyName)}`,
  age: sql<string | null>`${live(cbv.id, cbv.age, characters.legacyAge)}`,
  gender: sql<
    string | null
  >`${live(cbv.id, cbv.gender, characters.legacyGender)}`,
  ethnicity: sql<
    string | null
  >`${live(cbv.id, cbv.ethnicity, characters.legacyEthnicity)}`,
  physicalDescription: sql<
    string | null
  >`${live(cbv.id, cbv.physicalDescription, characters.legacyPhysicalDescription)}`,
  distinguishingFeatures: sql<
    string | null
  >`${live(cbv.id, cbv.distinguishingFeatures, characters.legacyDistinguishingFeatures)}`,
  personality: sql<
    string | null
  >`${live(cbv.id, cbv.personality, characters.legacyPersonality)}`,
  movement: sql<
    string | null
  >`${live(cbv.id, cbv.movement, characters.legacyMovement)}`,
  voiceOnly:
    sql`${live(cbv.id, cbv.voiceOnly, characters.legacyVoiceOnly)}`.mapWith(
      Boolean
    ),
  isPerson:
    sql`${live(cbv.id, cbv.isPerson, characters.legacyIsPerson)}`.mapWith(
      Boolean
    ),
  consistencyTag: sql<
    string | null
  >`${live(cbv.id, cbv.consistencyTag, characters.legacyConsistencyTag)}`,
};

/**
 * The clothing a character's bible held before looks owned it (#2015). Read
 * only for a character with no look yet.
 */
export const legacyBibleClothing = sql<
  string | null
>`${live(cbv.id, cbv.legacyStandardClothing, characters.legacyStandardClothing)}`;

/** Select fields: a sequence location's bible, resolved. */
export const locationBibleColumns = {
  name: sql<string>`${live(lbv.id, lbv.name, sequenceLocations.legacyName)}`,
  type: sql<
    string | null
  >`${live(lbv.id, lbv.type, sequenceLocations.legacyType)}`,
  description: sql<
    string | null
  >`${live(lbv.id, lbv.description, sequenceLocations.legacyDescription)}`,
  architecturalStyle: sql<
    string | null
  >`${live(lbv.id, lbv.architecturalStyle, sequenceLocations.legacyArchitecturalStyle)}`,
  keyFeatures: sql<
    string | null
  >`${live(lbv.id, lbv.keyFeatures, sequenceLocations.legacyKeyFeatures)}`,
  ambiance: sql<
    string | null
  >`${live(lbv.id, lbv.ambiance, sequenceLocations.legacyAmbiance)}`,
  consistencyTag: sql<
    string | null
  >`${live(lbv.id, lbv.consistencyTag, sequenceLocations.legacyConsistencyTag)}`,
};

/**
 * One column of a version appended by `INSERT … SELECT` (#1862): the patch's
 * value when the caller set it, else the live value copied INSIDE the batch,
 * so an edit landing between the caller's read and its write survives (the
 * scene writer's pattern, `scenes.ts`). Aliased to the column's name so the
 * select maps onto the insert.
 */
export const patchedOrLive = (
  patched: string | boolean | null | undefined,
  live: SQL | AnySQLiteColumn,
  column: AnySQLiteColumn
): SQL.Aliased => {
  if (patched === undefined) return sql`${live}`.as(column.name);
  const bound = typeof patched === 'boolean' ? (patched ? 1 : 0) : patched;
  return sql`${bound}`.as(column.name);
};

/** `created_at` for an `INSERT … SELECT`, which skips `$defaultFn`. */
export const nowSeconds = () => sql`${Math.floor(Date.now() / 1000)}`;

/**
 * A guarded version write landed only if the pointer now names it. The
 * guard is the pointer the writer read: a second edit that read the same
 * version and landed first wins, and this one fails here instead of
 * silently dropping that edit's field.
 */
export const assertVersionLanded = (
  what: string,
  pointer: string | null,
  versionId: string | null
): void => {
  if (versionId !== null && pointer !== versionId) {
    throw new ConflictError(
      `${what} changed while you were editing it. Reload and try again.`
    );
  }
};

/** The character bible fields of any object that carries them. */
export const pickCharacterBible = (c: CharacterBible): CharacterBible => ({
  name: c.name,
  age: c.age,
  gender: c.gender,
  ethnicity: c.ethnicity,
  physicalDescription: c.physicalDescription,
  distinguishingFeatures: c.distinguishingFeatures,
  personality: c.personality,
  movement: c.movement,
  voiceOnly: c.voiceOnly,
  isPerson: c.isPerson,
  consistencyTag: c.consistencyTag,
});

/** The location bible fields of any object that carries them. */
export const pickLocationBible = (l: LocationBible): LocationBible => ({
  name: l.name,
  type: l.type,
  description: l.description,
  architecturalStyle: l.architecturalStyle,
  keyFeatures: l.keyFeatures,
  ambiance: l.ambiance,
  consistencyTag: l.consistencyTag,
});

function setDefined<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
) {
  if (value !== undefined) target[key] = value;
}

/** `base` with every field `patch` sets; an `undefined` means "leave as is". */
export function mergeDefined<T extends object>(
  base: T,
  patch: Partial<T>,
  fields: readonly (keyof T)[]
): T {
  const out = { ...base };
  for (const key of fields) setDefined(out, key, patch[key]);
  return out;
}

/**
 * The fields whose stored value differs, exactly. An append is keyed on this:
 * any change the user made must be kept, whitespace included.
 */
function bibleFieldsChanged<T extends object>(
  fields: readonly (keyof T)[],
  before: T,
  after: T
): (keyof T)[] {
  return fields.filter((key) => (before[key] ?? null) !== (after[key] ?? null));
}

export const characterBibleChanged = (
  before: CharacterBible,
  after: CharacterBible
) => bibleFieldsChanged(CHARACTER_BIBLE_FIELDS, before, after);

export const locationBibleChanged = (
  before: LocationBible,
  after: LocationBible
) => bibleFieldsChanged(LOCATION_BIBLE_FIELDS, before, after);
