/**
 * Sheet claims (#1113): the pointer-claim contract for the four sheet
 * workflows. The trigger points a claim column on the parent row at the id the
 * run's result will carry; every write that changes a sheet input, or picks a
 * sheet, clears it; the run's completion promotes in one guarded batch and
 * parks its result as a divergent variant when the claim has moved.
 *
 * The demote builders here are statements, not calls, so a mutator puts them
 * in the SAME `db.batch` as its own write — the edit and the revocation land
 * together or not at all.
 */

import { and, eq, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '@/platform/server/db/client';
import {
  characterSheetVariants,
  characters,
  locationSheetVariants,
  sequenceLocations,
  talent,
} from '@/platform/server/db/schema';
import type {
  CharacterSheetInputHash,
  LocationSheetInputHash,
} from '@/shots/input-hash';

/** Clear every character sheet claim matching `where`. */
export const demoteCharacterSheetClaims = (db: Database, where: SQL) =>
  db
    .update(characters)
    .set({ pendingPromoteSheetVersionId: null })
    .where(and(where, isNotNull(characters.pendingPromoteSheetVersionId)));

/** Clear every sequence-location reference claim matching `where`. */
export const demoteLocationReferenceClaims = (db: Database, where: SQL) =>
  db
    .update(sequenceLocations)
    .set({ pendingPromoteReferenceVersionId: null })
    .where(
      and(where, isNotNull(sequenceLocations.pendingPromoteReferenceVersionId))
    );

/** Clear a library talent's sheet claim. */
export const demoteTalentSheetClaim = (db: Database, talentId: string) =>
  db
    .update(talent)
    .set({ pendingPromoteSheetId: null })
    .where(
      and(eq(talent.id, talentId), isNotNull(talent.pendingPromoteSheetId))
    );

/** Every sheet claim in a sequence: its style is an input to all of them. */
export const demoteSequenceSheetClaims = (db: Database, sequenceId: string) =>
  [
    demoteCharacterSheetClaims(db, eq(characters.sequenceId, sequenceId)),
    demoteLocationReferenceClaims(
      db,
      eq(sequenceLocations.sequenceId, sequenceId)
    ),
  ] as const;

export type SheetLanding = 'promoted' | 'parked';

type LandArgs<H> = {
  /** The claim id the trigger minted; becomes the version row's id. */
  versionId: string;
  url: string;
  storagePath: string;
  inputHash: H | null;
  model: string;
  workflowRunId: string;
};

/**
 * Land a character sheet run's result (#1113). One batch: append the version
 * row under the claimed id, then move the pointer ONLY while the claim still
 * names it. A missed claim parks the row as divergent (unless an identical
 * divergent twin is already parked — the partial unique index allows one).
 * The status settles to `completed` only when no newer run holds the pointer.
 *
 * Retry-safe: the insert is keyed on the claimed id, and the outcome is read
 * from the pointer, not from whether this attempt's UPDATE matched.
 */
export async function landCharacterSheet(
  db: Database,
  args: LandArgs<CharacterSheetInputHash> & { characterId: string }
): Promise<SheetLanding> {
  const { characterId, versionId } = args;
  const now = new Date();
  const twin = alias(characterSheetVariants, 'twin');
  const [, , , , [row]] = await db.batch([
    db
      .insert(characterSheetVariants)
      .values({
        id: versionId,
        characterId,
        model: args.model,
        url: args.url,
        storagePath: args.storagePath,
        status: 'completed',
        workflowRunId: args.workflowRunId,
        generatedAt: now,
        inputHash: args.inputHash,
      })
      .onConflictDoNothing(),
    db
      .update(characters)
      .set({
        selectedSheetVersionId: versionId,
        pendingPromoteSheetVersionId: null,
        sheetStatus: 'completed',
        sheetError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(characters.id, characterId),
          eq(characters.pendingPromoteSheetVersionId, versionId)
        )
      ),
    db
      .update(characterSheetVariants)
      .set({ divergedAt: now, updatedAt: now })
      .where(
        and(
          eq(characterSheetVariants.id, versionId),
          isNull(characterSheetVariants.divergedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(characters)
              .where(
                and(
                  eq(characters.id, characterId),
                  eq(characters.selectedSheetVersionId, versionId)
                )
              )
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(twin)
              .where(
                and(
                  eq(twin.characterId, characterId),
                  eq(twin.model, args.model),
                  eq(twin.inputHash, sql`${characterSheetVariants.inputHash}`),
                  isNotNull(twin.divergedAt)
                )
              )
          )
        )
      ),
    db
      .update(characters)
      .set({ sheetStatus: 'completed', sheetError: null, updatedAt: now })
      .where(
        and(
          eq(characters.id, characterId),
          isNull(characters.pendingPromoteSheetVersionId),
          eq(characters.sheetStatus, 'generating')
        )
      ),
    db
      .select({ selected: characters.selectedSheetVersionId })
      .from(characters)
      .where(eq(characters.id, characterId)),
  ]);
  if (!row) throw new Error(`Character ${characterId} not found`);
  return row.selected === versionId ? 'promoted' : 'parked';
}

/** {@link landCharacterSheet} for a sequence location's reference. */
export async function landLocationReference(
  db: Database,
  args: LandArgs<LocationSheetInputHash> & { locationId: string }
): Promise<SheetLanding> {
  const { locationId, versionId } = args;
  const now = new Date();
  const twin = alias(locationSheetVariants, 'twin');
  const [, , , , [row]] = await db.batch([
    db
      .insert(locationSheetVariants)
      .values({
        id: versionId,
        parentType: 'sequence_location',
        parentId: locationId,
        model: args.model,
        url: args.url,
        storagePath: args.storagePath,
        status: 'completed',
        workflowRunId: args.workflowRunId,
        generatedAt: now,
        inputHash: args.inputHash,
      })
      .onConflictDoNothing(),
    db
      .update(sequenceLocations)
      .set({
        selectedReferenceVersionId: versionId,
        pendingPromoteReferenceVersionId: null,
        referenceStatus: 'completed',
        referenceError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sequenceLocations.id, locationId),
          eq(sequenceLocations.pendingPromoteReferenceVersionId, versionId)
        )
      ),
    db
      .update(locationSheetVariants)
      .set({ divergedAt: now, updatedAt: now })
      .where(
        and(
          eq(locationSheetVariants.id, versionId),
          isNull(locationSheetVariants.divergedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(sequenceLocations)
              .where(
                and(
                  eq(sequenceLocations.id, locationId),
                  eq(sequenceLocations.selectedReferenceVersionId, versionId)
                )
              )
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(twin)
              .where(
                and(
                  eq(twin.parentType, 'sequence_location'),
                  eq(twin.parentId, locationId),
                  eq(twin.model, args.model),
                  eq(twin.inputHash, sql`${locationSheetVariants.inputHash}`),
                  isNotNull(twin.divergedAt)
                )
              )
          )
        )
      ),
    db
      .update(sequenceLocations)
      .set({
        referenceStatus: 'completed',
        referenceError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sequenceLocations.id, locationId),
          isNull(sequenceLocations.pendingPromoteReferenceVersionId),
          eq(sequenceLocations.referenceStatus, 'generating')
        )
      ),
    db
      .select({ selected: sequenceLocations.selectedReferenceVersionId })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, locationId)),
  ]);
  if (!row) throw new Error(`SequenceLocation ${locationId} not found`);
  return row.selected === versionId ? 'promoted' : 'parked';
}

/**
 * For a bible upsert's `ON CONFLICT DO UPDATE SET` (#1113): keep `claim` while
 * every sheet input column is unchanged, else clear it. A re-analysis that
 * rewrites a field the sheet reads revokes an in-flight run, in the same
 * statement as the write; an identical rewrite does not.
 */
export function keepClaimUnlessChanged(
  claim: string,
  inputColumns: readonly string[]
): SQL {
  const same = inputColumns
    .map((col) => `"${col}" IS excluded."${col}"`)
    .join(' AND ');
  return sql.raw(`CASE WHEN ${same} THEN "${claim}" ELSE NULL END`);
}
