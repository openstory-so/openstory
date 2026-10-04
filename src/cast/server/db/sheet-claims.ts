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

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type {
  AnySQLiteColumn,
  SQLiteInsertValue,
  SQLiteTable,
  SQLiteUpdateSetSource,
} from 'drizzle-orm/sqlite-core';
import type { Database } from '@/platform/server/db/client';
import {
  characterSheetVariants,
  locationSheetVariants,
  sequenceCast,
  sequenceCastLooks,
  sequenceLocations,
  talent,
} from '@/platform/server/db/schema';
import type {
  CharacterSheetInputHash,
  LocationSheetInputHash,
} from '@/shots/input-hash';

/**
 * Clear the sheet claim of every look (#2015) of the cast links (#2017)
 * matching `where`, a condition on `sequence_cast`: the bible a sequence
 * pins, its cast talent and its style feed all of that cast's sheets.
 */
export const demoteCharacterSheetClaims = (db: Database, where: SQL) =>
  db
    .update(sequenceCastLooks)
    .set({ pendingPromoteSheetVersionId: null })
    .where(
      and(
        isNotNull(sequenceCastLooks.pendingPromoteSheetVersionId),
        inArray(
          sequenceCastLooks.castId,
          db.select({ id: sequenceCast.id }).from(sequenceCast).where(where)
        )
      )
    );

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
    demoteCharacterSheetClaims(db, eq(sequenceCast.sequenceId, sequenceId)),
    demoteLocationReferenceClaims(
      db,
      eq(sequenceLocations.sequenceId, sequenceId)
    ),
  ] as const;

export type SheetLanding = 'promoted' | 'parked';

type LandArgs<H> = {
  /** The claim id the trigger minted; becomes the version row's id. */
  versionId: string;
  /**
   * False for a run queued before #1113: it holds no claim, so it lands only
   * while no newer run holds one, and parks rather than revoke that claim.
   */
  claimed: boolean;
  url: string;
  storagePath: string;
  inputHash: H | null;
  /** The bible version the run read (#1600); null when unknown. */
  bibleVersionId: string | null;
  model: string;
  workflowRunId: string;
};

/** What {@link landSheetVersion} needs from one sheet entity's tables. */
type SheetLandSpec<P extends SQLiteTable, V extends SQLiteTable> = {
  /** Named in the not-found error. */
  entity: string;
  parent: P;
  isParent: SQL;
  /** The selection pointer and its claim column on the parent. */
  selected: AnySQLiteColumn;
  claim: AnySQLiteColumn;
  isGenerating: SQL;
  /** Pointer to the version, claim cleared, status completed. */
  promote: SQLiteUpdateSetSource<P>;
  /** Status completed, error cleared. */
  settle: SQLiteUpdateSetSource<P>;
  variants: V;
  version: SQLiteInsertValue<V>;
  versionIdColumn: AnySQLiteColumn;
  divergedAt: AnySQLiteColumn;
  park: SQLiteUpdateSetSource<V>;
  /** An identical divergent twin already parked (the partial unique index allows one). */
  twinParked: SQLWrapper;
};

/**
 * The one sheet landing batch (#1113, #1865): append the version row under the
 * claimed id, then move the pointer ONLY while the claim still names it. A
 * missed claim parks the row as divergent (unless an identical divergent twin
 * is already parked). The status settles to `completed` only when no newer run
 * holds the pointer.
 *
 * Retry-safe: the insert is keyed on the claimed id, and the outcome is read
 * from the pointer, not from whether this attempt's UPDATE matched.
 */
async function landSheetVersion<P extends SQLiteTable, V extends SQLiteTable>(
  db: Database,
  spec: SheetLandSpec<P, V>,
  { versionId, claimed }: Pick<LandArgs<unknown>, 'versionId' | 'claimed'>
): Promise<SheetLanding> {
  const [, , , , [row]] = await db.batch([
    db.insert(spec.variants).values(spec.version).onConflictDoNothing(),
    db
      .update(spec.parent)
      .set(spec.promote)
      .where(
        and(
          spec.isParent,
          claimed ? eq(spec.claim, versionId) : isNull(spec.claim)
        )
      ),
    db
      .update(spec.variants)
      .set(spec.park)
      .where(
        and(
          eq(spec.versionIdColumn, versionId),
          isNull(spec.divergedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(spec.parent)
              .where(and(spec.isParent, eq(spec.selected, versionId)))
          ),
          notExists(spec.twinParked)
        )
      ),
    db
      .update(spec.parent)
      .set(spec.settle)
      .where(and(spec.isParent, isNull(spec.claim), spec.isGenerating)),
    db
      .select({ selected: spec.selected })
      .from(spec.parent)
      .where(spec.isParent),
  ]);
  if (!row) throw new Error(`${spec.entity} not found`);
  return row.selected === versionId ? 'promoted' : 'parked';
}

/** The version row's columns both variant tables share. */
const versionRow = <H>(args: LandArgs<H>, now: Date) => ({
  id: args.versionId,
  model: args.model,
  url: args.url,
  storagePath: args.storagePath,
  status: 'completed' as const,
  workflowRunId: args.workflowRunId,
  generatedAt: now,
  inputHash: args.inputHash,
  bibleVersionId: args.bibleVersionId,
});

/**
 * Land a look's sheet run (#2015): {@link landSheetVersion}, with the
 * sequence's cast look (#2017) as the parent — it holds the pointer and the
 * claim. The caller resolves it (`requireLook`).
 */
export function landCharacterSheet(
  db: Database,
  args: LandArgs<CharacterSheetInputHash> & {
    characterId: string;
    lookId: string;
    /** The `sequence_cast_looks` row the run's claim is on. */
    castLookId: string;
    /** The look version the run read; null when unknown. */
    lookVersionId: string | null;
  }
): Promise<SheetLanding> {
  const { characterId, lookId, castLookId, versionId } = args;
  const now = new Date();
  const twin = alias(characterSheetVariants, 'twin');
  return landSheetVersion(
    db,
    {
      entity: `Look ${lookId}`,
      parent: sequenceCastLooks,
      isParent: eq(sequenceCastLooks.id, castLookId),
      selected: sequenceCastLooks.selectedSheetVersionId,
      claim: sequenceCastLooks.pendingPromoteSheetVersionId,
      isGenerating: eq(sequenceCastLooks.sheetStatus, 'generating'),
      promote: {
        selectedSheetVersionId: versionId,
        pendingPromoteSheetVersionId: null,
        sheetStatus: 'completed',
        sheetError: null,
        updatedAt: now,
      },
      settle: { sheetStatus: 'completed', sheetError: null, updatedAt: now },
      variants: characterSheetVariants,
      version: {
        ...versionRow(args, now),
        characterId,
        lookId,
        lookVersionId: args.lookVersionId,
      },
      versionIdColumn: characterSheetVariants.id,
      divergedAt: characterSheetVariants.divergedAt,
      park: { divergedAt: now, updatedAt: now },
      twinParked: db
        .select({ one: sql`1` })
        .from(twin)
        .where(
          and(
            eq(twin.lookId, lookId),
            eq(twin.model, args.model),
            eq(twin.inputHash, sql`${characterSheetVariants.inputHash}`),
            isNotNull(twin.divergedAt)
          )
        ),
    },
    args
  );
}

/** Land a sequence location reference run's result: {@link landSheetVersion}. */
export function landLocationReference(
  db: Database,
  args: LandArgs<LocationSheetInputHash> & { locationId: string }
): Promise<SheetLanding> {
  const { locationId, versionId } = args;
  const now = new Date();
  const twin = alias(locationSheetVariants, 'twin');
  return landSheetVersion(
    db,
    {
      entity: `SequenceLocation ${locationId}`,
      parent: sequenceLocations,
      isParent: eq(sequenceLocations.id, locationId),
      selected: sequenceLocations.selectedReferenceVersionId,
      claim: sequenceLocations.pendingPromoteReferenceVersionId,
      isGenerating: eq(sequenceLocations.referenceStatus, 'generating'),
      promote: {
        selectedReferenceVersionId: versionId,
        pendingPromoteReferenceVersionId: null,
        referenceStatus: 'completed',
        referenceError: null,
        updatedAt: now,
      },
      settle: {
        referenceStatus: 'completed',
        referenceError: null,
        updatedAt: now,
      },
      variants: locationSheetVariants,
      version: {
        ...versionRow(args, now),
        parentType: 'sequence_location',
        parentId: locationId,
      },
      versionIdColumn: locationSheetVariants.id,
      divergedAt: locationSheetVariants.divergedAt,
      park: { divergedAt: now, updatedAt: now },
      twinParked: db
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
        ),
    },
    args
  );
}
