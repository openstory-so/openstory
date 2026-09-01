/**
 * Trigger-time regenerate-shots snapshot for the two recast flows, plus the
 * in-workflow merge of the sheet its awaited child produces.
 *
 * Both recast workflows used to rebuild this payload inside a `step.do`,
 * minutes after the trigger and after a full child image generation — eight
 * live reads (including a mutable selection-pointer deref) whose results the
 * user never authorised. Everything except one field is resolvable at the
 * trigger, so it is resolved here, in the server fn.
 *
 * The exception is the sheet the awaited child generates: its URL and input
 * hash genuinely postdate the trigger. The trigger stamps
 * {@link PENDING_SHEET_URL} / {@link PENDING_SHEET_HASH} in their place and
 * {@link mergeRecastSheetIntoSnapshots} substitutes the child's result — a
 * pure in-memory merge, no DB read.
 */

import { computeShotImageInputHash } from '@/lib/ai/input-hash';
import type { TextToImageModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  CharacterWithSheet,
  SequenceLocationWithReference,
} from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import type { RegenerateShotSnapshot } from '@/lib/workflow/types';
import {
  buildRegenerateShotSnapshot,
  computeRegenerateShotsBatchHash,
} from '@/lib/workflows/regenerate-shots-snapshot';

const logger = getLogger(['openstory', 'workflows', 'recast-snapshot']);

/**
 * Stand-ins for the sheet the awaited child has not generated yet. They must
 * never collide with a real media URL or a real sha256 hash.
 */
export const PENDING_SHEET_URL = 'recast://pending-sheet-url';
export const PENDING_SHEET_HASH = 'recast://pending-sheet-hash';

/** The entity whose sheet the awaited child regenerates. */
export type RecastSubject =
  | { kind: 'character'; character: CharacterWithSheet }
  | { kind: 'location'; location: SequenceLocationWithReference };

export type RecastRegenerateSnapshot = {
  shotSnapshots: RegenerateShotSnapshot[];
  /** Batch hash over the pre-merge snapshots (payload tamper check). */
  snapshotInputHash: string;
};

/**
 * Resolve every regenerate-shots input from live scoped state, at the trigger.
 *
 * Shots whose anchor frame has no selected image prompt are dropped with a
 * warning rather than throwing: a recast's primary job is the sheet, and one
 * prompt-less shot must not block it. The dropped ids are absent from the
 * returned snapshots, which are the workflow's only notion of scope.
 */
export async function buildRecastRegenerateSnapshots(params: {
  scopedDb: ScopedDb;
  sequenceId: string;
  shotIds: string[];
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
  subject: RecastSubject;
}): Promise<RecastRegenerateSnapshot> {
  const { scopedDb, sequenceId, shotIds, imageModel, aspectRatio, subject } =
    params;

  if (shotIds.length === 0) {
    return {
      shotSnapshots: [],
      snapshotInputHash: await computeRegenerateShotsBatchHash({
        sequenceId,
        imageModel,
        aspectRatio,
        shotSnapshots: [],
      }),
    };
  }

  const [characters, locations, elements, shots, sceneContext] =
    await Promise.all([
      scopedDb.characters.listWithSheets(sequenceId),
      scopedDb.sequenceLocations.listWithReferences(sequenceId),
      scopedDb.sequenceElements.list(sequenceId),
      scopedDb.shots.getByIds(shotIds),
      loadSceneContextBySequence(scopedDb, sequenceId),
    ]);

  // Both list reads are completed-only, and the recast already flipped the
  // subject to `generating` — so splice it back in behind the sentinels.
  const resolvedCharacters =
    subject.kind === 'character'
      ? [
          ...characters.filter((c) => c.id !== subject.character.id),
          {
            ...subject.character,
            sheetImageUrl: PENDING_SHEET_URL,
            sheetInputHash: PENDING_SHEET_HASH,
            selectedSheetVersionId: null,
          },
        ]
      : characters;
  const resolvedLocations =
    subject.kind === 'location'
      ? [
          ...locations.filter((l) => l.id !== subject.location.id),
          {
            ...subject.location,
            referenceImageUrl: PENDING_SHEET_URL,
            referenceInputHash: PENDING_SHEET_HASH,
            selectedReferenceVersionId: null,
          },
        ]
      : locations;

  const framesByShot = await scopedDb.frames.getAnchorsByShots(
    shots.map((s) => s.id)
  );
  const promptByFrameId =
    await scopedDb.framePromptVersions.getSelectedByFrameIds(
      [...framesByShot.values()].map((f) => f.id)
    );

  const shotSnapshots: RegenerateShotSnapshot[] = [];
  for (const shot of shots) {
    const frame = framesByShot.get(shot.id);
    const promptVersion = frame ? promptByFrameId.get(frame.id) : undefined;
    if (!promptVersion?.text) {
      logger.warn(
        `[recast] Skipping shot ${shot.id}: no selected image prompt to regenerate from`
      );
      continue;
    }
    shotSnapshots.push(
      await buildRegenerateShotSnapshot({
        shot,
        scene: resolveSceneForShot(shot, sceneContext).scene,
        imagePrompt: promptVersion.text,
        imagePromptVersionId: promptVersion.id,
        frameId: frame?.id,
        characters: resolvedCharacters,
        locations: resolvedLocations,
        elements,
        imageModel,
        aspectRatio,
      })
    );
  }

  return {
    shotSnapshots,
    snapshotInputHash: await computeRegenerateShotsBatchHash({
      sequenceId,
      imageModel,
      aspectRatio,
      shotSnapshots,
    }),
  };
}

/** Replace the sentinel hash, preserving `sortedRefHashes`' contract. */
function substituteHash(
  hashes: string[],
  sheetInputHash: string | null
): string[] {
  const rest = hashes.filter((h) => h !== PENDING_SHEET_HASH);
  if (rest.length === hashes.length) return hashes;
  return (sheetInputHash ? [...rest, sheetInputHash] : rest).sort();
}

/**
 * Substitute the awaited child's sheet for the trigger's sentinels and rehash.
 * Pure: the only new information is `sheetImageUrl` / `sheetInputHash`, both
 * carried in memory from the child's result and its snapshot DTO.
 */
export async function mergeRecastSheetIntoSnapshots(params: {
  shotSnapshots: RegenerateShotSnapshot[];
  sequenceId: string;
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
  sheetImageUrl: string;
  /** The hash the sheet workflow stamped on the row it just wrote. */
  sheetInputHash: string | null;
}): Promise<RecastRegenerateSnapshot> {
  const {
    shotSnapshots,
    sequenceId,
    imageModel,
    aspectRatio,
    sheetImageUrl,
    sheetInputHash,
  } = params;

  const merged = await Promise.all(
    shotSnapshots.map(async (snapshot) => {
      const substituteUrl = (
        refs: RegenerateShotSnapshot['characterRefs']
      ): RegenerateShotSnapshot['characterRefs'] =>
        refs.map((ref) =>
          ref.referenceImageUrl === PENDING_SHEET_URL
            ? { ...ref, referenceImageUrl: sheetImageUrl }
            : ref
        );

      const characterSheetHashes = substituteHash(
        snapshot.characterSheetHashes,
        sheetInputHash
      );
      const locationSheetHashes = substituteHash(
        snapshot.locationSheetHashes,
        sheetInputHash
      );
      const characterRefs = substituteUrl(snapshot.characterRefs);
      const locationRefs = substituteUrl(snapshot.locationRefs);

      const touched =
        characterSheetHashes !== snapshot.characterSheetHashes ||
        locationSheetHashes !== snapshot.locationSheetHashes ||
        characterRefs.some(
          (ref, i) =>
            ref.referenceImageUrl !==
            snapshot.characterRefs[i]?.referenceImageUrl
        ) ||
        locationRefs.some(
          (ref, i) =>
            ref.referenceImageUrl !==
            snapshot.locationRefs[i]?.referenceImageUrl
        );
      if (!touched) return snapshot;

      return {
        ...snapshot,
        characterRefs,
        locationRefs,
        characterSheetHashes,
        locationSheetHashes,
        snapshotInputHash: await computeShotImageInputHash({
          kind: 'thumbnail',
          visualPrompt: snapshot.imagePrompt,
          imageModel,
          aspectRatio,
          characterSheetHashes,
          locationSheetHashes,
          elementReferenceHashes: snapshot.elementReferenceHashes,
        }),
      };
    })
  );

  return {
    shotSnapshots: merged,
    snapshotInputHash: await computeRegenerateShotsBatchHash({
      sequenceId,
      imageModel,
      aspectRatio,
      shotSnapshots: merged,
    }),
  };
}
