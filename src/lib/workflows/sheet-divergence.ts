/**
 * Sheet workflow divergence routing.
 *
 * Helpers for the character/location/talent sheet workflows to decide, at
 * write time, whether the freshly generated artifact is convergent (apply as
 * primary) or divergent (save to a `*_sheet_variants` table without
 * disturbing the live entity).
 *
 * The decision is a hash comparison: callers pass the `snapshotInputHash`
 * computed when the workflow was triggered (frozen on the payload)
 * and the `currentInputHash` recomputed from live scoped-DB state at write
 * time. If they differ, the inputs changed mid-flight — the result belongs
 * in a variants row, and the UI is notified via `stale:detected`.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import type { LocationSheetVariantParentType } from '@/lib/db/schema';
// `ScopedDb` is imported for type extraction only; the helpers themselves
// take a narrower `SheetDivergenceScopedDb` shape (defined below).
import {
  getGenerationChannel,
  getLocationChannel,
  getTalentChannel,
} from '@/shared/realtime';

// Subset of ScopedDb used by the helpers below. Defined structurally so the
// full ScopedDb is assignable (production passes it directly) and tests can
// build a minimal mock without `as any`. The return type is narrowed to
// `{ id: string }` because that's all these helpers consume from the row.
type CharInsertArgs = Parameters<
  ScopedDb['characterSheetVariants']['insertDivergent']
>[0];
type LocInsertArgs = Parameters<
  ScopedDb['locationSheetVariants']['insertDivergent']
>[0];
type TalInsertArgs = Parameters<
  ScopedDb['talentSheetVariants']['insertDivergent']
>[0];
export type SheetDivergenceScopedDb = {
  characterSheetVariants: {
    insertDivergent: (values: CharInsertArgs) => Promise<{ id: string }>;
  };
  locationSheetVariants: {
    insertDivergent: (values: LocInsertArgs) => Promise<{ id: string }>;
  };
  talentSheetVariants: {
    insertDivergent: (values: TalInsertArgs) => Promise<{ id: string }>;
  };
};

export type SheetDivergenceDecision =
  | { kind: 'convergent' }
  | { kind: 'divergent'; snapshotInputHash: string; currentInputHash: string };

export function decideSheetDivergence(
  snapshotInputHash: string | null | undefined,
  currentInputHash: string | null | undefined
): SheetDivergenceDecision {
  // Either side missing → can't prove divergence; treat as convergent. Matches
  // the project-wide "null hash = unknown, never stale" policy applied to
  // pre-hash-tracking rows (see workflow/types.ts on `RegenerateShotSnapshot`).
  if (!snapshotInputHash || !currentInputHash) {
    return { kind: 'convergent' };
  }
  if (snapshotInputHash === currentInputHash) {
    return { kind: 'convergent' };
  }
  return {
    kind: 'divergent',
    snapshotInputHash,
    currentInputHash,
  };
}

export type SaveDivergentCharacterSheetArgs = {
  scopedDb: SheetDivergenceScopedDb;
  characterId: string;
  /** Required: character sheet workflows are sequence-scoped. */
  sequenceId: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: string;
};

export async function saveDivergentCharacterSheet({
  scopedDb,
  characterId,
  sequenceId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentCharacterSheetArgs): Promise<string> {
  const variant = await scopedDb.characterSheetVariants.insertDivergent({
    characterId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await getGenerationChannel(sequenceId).emit('generation.stale:detected', {
    entityType: 'character',
    entityId: characterId,
    artifact: 'sheet',
    snapshotInputHash,
    divergedVariantId: variant.id,
  });
  return variant.id;
}

/**
 * Discriminated parent for location sheets: a single variants table services
 * both sequence-scoped locations and library locations, so callers must pass
 * the parent kind alongside its id. The kind also drives realtime channel
 * routing — sequence locations notify via the sequence channel, library
 * locations via the per-location channel.
 *
 * Discriminator strings are pinned to `LocationSheetVariantParentType` via
 * `Extract<…>`. The bidirectional enum-coverage assert below converts
 * enum drift in either direction (DB enum gains/loses a value, or this
 * union does) into a TS error in this file — without it, `Extract<X, 'a'>`
 * resolves to `'a'` regardless of new enum members and the drift goes
 * undetected.
 */
type LocationSheetParent =
  | {
      type: Extract<LocationSheetVariantParentType, 'sequence_location'>;
      id: string;
      sequenceId: string;
    }
  | {
      type: Extract<LocationSheetVariantParentType, 'library_location'>;
      id: string;
    };

// Bidirectional enum-coverage check: every parent kind maps to a union
// branch and every union branch's discriminator is a known parent kind. If
// either side gains a value not present in the other, this constant fails
// to type-check with a "Type 'never' is not assignable to type 'true'" error.
type _LocationSheetParentCoversEnum =
  LocationSheetVariantParentType extends LocationSheetParent['type']
    ? LocationSheetParent['type'] extends LocationSheetVariantParentType
      ? true
      : never
    : never;
const _locationSheetParentCoversEnum: _LocationSheetParentCoversEnum = true;
void _locationSheetParentCoversEnum;

export type SaveDivergentLocationSheetArgs = {
  scopedDb: SheetDivergenceScopedDb;
  parent: LocationSheetParent;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: string;
};

export async function saveDivergentLocationSheet({
  scopedDb,
  parent,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentLocationSheetArgs): Promise<string> {
  const parentType: LocationSheetVariantParentType = parent.type;
  const variant = await scopedDb.locationSheetVariants.insertDivergent({
    parentType,
    parentId: parent.id,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });

  switch (parent.type) {
    case 'library_location':
      await getLocationChannel(parent.id).emit('generation.stale:detected', {
        entityType: 'library-location',
        entityId: parent.id,
        artifact: 'sheet',
        snapshotInputHash,
        divergedVariantId: variant.id,
      });
      break;
    case 'sequence_location':
      await getGenerationChannel(parent.sequenceId).emit(
        'generation.stale:detected',
        {
          entityType: 'location',
          entityId: parent.id,
          artifact: 'sheet',
          snapshotInputHash,
          divergedVariantId: variant.id,
        }
      );
      break;
    default: {
      // Exhaustive guard — adding a new parent kind without a routing case
      // here triggers a TS error rather than a silent fall-through.
      const _exhaustive: never = parent;
      throw new Error(
        `Unhandled location sheet parent: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
  return variant.id;
}

export type SaveDivergentTalentSheetArgs = {
  scopedDb: SheetDivergenceScopedDb;
  talentSheetId: string;
  /**
   * Parent talent id — used for realtime channel routing. Required: the
   * talent channel is the only place the talent UI subscribes for stale
   * events. Passing nothing here would silently drop the notification.
   */
  talentId: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: string;
};

export async function saveDivergentTalentSheet({
  scopedDb,
  talentSheetId,
  talentId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentTalentSheetArgs): Promise<string> {
  const variant = await scopedDb.talentSheetVariants.insertDivergent({
    talentSheetId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await getTalentChannel(talentId).emit('generation.stale:detected', {
    entityType: 'talent',
    entityId: talentSheetId,
    artifact: 'sheet',
    snapshotInputHash,
    divergedVariantId: variant.id,
  });
  return variant.id;
}
