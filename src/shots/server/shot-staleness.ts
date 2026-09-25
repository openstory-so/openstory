/**
 * Per-shot staleness computation (#1077) — shared by the `getShotStaleness*`
 * server fns and `UpdateStaleShotsWorkflow` (#1085). Each value is computed by
 * re-deriving the current input hash from live scoped state and comparing it
 * to the stored `*_input_hash`.
 */

import {
  rendersReferenceOnly,
  type StartFrameSequence,
} from '@/shots/use-start-frame';
import { z } from 'zod';
import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/models/models';
import {
  hashMotionPromptInput,
  hashVisualPromptInput,
  motionPromptInputHashMatches,
  visualPromptInputHashMatches,
  voiceOnlyMovedSince,
} from '@/shots/input-hash';
import {
  loadNarrowShotPromptContext,
  type ShotPromptContextRefs,
  type ShotPromptContextSequence,
} from './prompt-context';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { AspectRatio } from '@/models/aspect-ratios';
import type {
  CharacterBible,
  CharacterBibleVersion,
  DbSceneId,
  SceneNarrative,
  SceneScriptVersion,
  SequenceStyleVersion,
  Frame,
  FramePromptVersion,
  FrameVariant,
  LocationBible,
  LocationBibleVersion,
  SequenceEvent,
  Shot,
  ShotPromptVersion,
} from '@/platform/server/db/schema';
import {
  characterBibleChanged,
  locationBibleChanged,
} from '@/cast/server/db/bible-versions';
import { dbSceneId } from '@/shots/scene-id';
import { parseStyleConfig, styleConfigHashBody } from '@/look/style-config';
import {
  narrativeFieldsChanged,
  sceneNarrativeOf,
} from '@/shots/scene-narrative';
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_CHANGED_LABELS,
} from '@/sequences/server/db/sequence-events';
import type { SequenceStatus } from '@/platform/server/db/schema/sequences';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { buildRegenerateShotSnapshot } from '@/shots/server/workflows/regenerate-shots-snapshot';
import { matchElementsToShotImage } from '@/shots/scene-matching';
import { getLogger } from '@/platform/logger';
import { loadSceneContextBySequence, type SceneContext } from './scene-script';
import {
  loadShotDialogueLines,
  shotPromptDialogueResolver,
  type ShotPromptDialogue,
} from './shot-dialogue';

const logger = getLogger(['openstory', 'shots', 'staleness']);

/**
 * Per-artifact staleness. Shared vocabulary — the client re-exports this type
 * rather than redeclaring it, so the two can't drift.
 *
 * `'updating'` (#1085): the stored hash diverges from live, but a live pending
 * claim (a pre-created `pending`/`generating` version row) exists whose
 * `pendingInputHash` equals the live hash — a job is already fixing exactly
 * this. Claims self-invalidate on edit: the live hash moves, the claim no
 * longer matches, and the artifact honestly reads 'stale' again.
 *
 * `'generating'` (#1121): the sequence itself is mid-run. See
 * `computeShotStaleness`'s early return.
 */
export type ArtifactStaleness =
  | 'stale'
  | 'fresh'
  | 'updating'
  | 'generating'
  | 'untracked'
  | 'unknown';

/**
 * The live input hashes computed during the comparison. Enqueue points reuse
 * them to stamp pending claims without recomputing; null when the branch
 * didn't run (untracked/unknown artifacts).
 */
type ShotLiveHashes = {
  thumbnail: string | null;
  visualPrompt: string | null;
  motionPrompt: string | null;
};

export type ShotStalenessResult = {
  thumbnail: ArtifactStaleness;
  visualPrompt: ArtifactStaleness;
  motionPrompt: ArtifactStaleness;
  liveHashes: ShotLiveHashes;
  /** Inputs edited since the stale artifacts were generated (#1194), as display labels. Empty when fresh or undeterminable. */
  causes: string[];
};

/** Every artifact unopinionated — the missing-anchor and no-scene cases. */
export const UNTRACKED_STALENESS: ShotStalenessResult = {
  thumbnail: 'untracked',
  visualPrompt: 'untracked',
  motionPrompt: 'untracked',
  liveHashes: { thumbnail: null, visualPrompt: null, motionPrompt: null },
  causes: [],
};

/** Every artifact deferred — the sequence is mid-run (#1121). */
export const GENERATING_STALENESS: ShotStalenessResult = {
  thumbnail: 'generating',
  visualPrompt: 'generating',
  motionPrompt: 'generating',
  liveHashes: { thumbnail: null, visualPrompt: null, motionPrompt: null },
  causes: [],
};

/**
 * The one status that means "a run owns this sequence's artifacts right now":
 * `triggerStoryboard` is the only writer (create / retry / regenerate), and it
 * rebuilds every shot. Nothing else — a shot regenerate, an Update all run —
 * moves the sequence off 'completed', so this never suppresses a genuine
 * post-edit staleness verdict.
 */
const isSequenceGenerating = (status: SequenceStatus): boolean =>
  status === 'processing';

/** Sequence-scoped rows loaded once for a batch of shot comparisons. */
export type ShotStalenessRefs = ShotPromptContextRefs;

/**
 * The sequence-wide rows a batch of comparisons shares: anchors, scene scripts,
 * selected stills and the reference bibles. One read each, not one per shot.
 */
export async function loadShotStalenessBatch(
  scopedDb: ScopedDb,
  sequence: { id: string; styleId: string | null }
) {
  const [anchorRows, sceneContext, characters, locations, elements, style] =
    await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
      sequence.styleId
        ? scopedDb.styles.getById(sequence.styleId)
        : Promise.resolve(null),
    ]);
  const refs: ShotStalenessRefs = { characters, locations, elements, style };
  return {
    anchorsByShot: new Map(anchorRows.map((f) => [f.shotId, f])),
    sceneContext,
    // Stills live on the selected `frame_variants` rows (#1067).
    selectedByFrame: await scopedDb.frameVariants.getSelectedByFrameIds(
      anchorRows.map((f) => f.id)
    ),
    refs,
  };
}

/**
 * Prompt versions, live claims, and settings-changed events for a whole
 * sequence, in a handful of reads (#1795). `computeShotStaleness` consults
 * this instead of querying once per shot. Absent map keys mean "no row".
 */
export type ShotStalenessReads = {
  selectedPromptByFrame: ReadonlyMap<string, FramePromptVersion>;
  latestPromptByFrame: ReadonlyMap<string, FramePromptVersion>;
  latestHashedPromptByFrame: ReadonlyMap<string, FramePromptVersion>;
  selectedMotionByShot: ReadonlyMap<string, ShotPromptVersion>;
  latestMotionByShot: ReadonlyMap<string, ShotPromptVersion>;
  latestHashedMotionByShot: ReadonlyMap<string, ShotPromptVersion>;
  liveVisualClaimsByFrame: ReadonlyMap<string, FramePromptVersion[]>;
  liveMotionClaimsByShot: ReadonlyMap<string, ShotPromptVersion[]>;
  liveImageClaimsByFrame: ReadonlyMap<string, FrameVariant[]>;
  promptById: ReadonlyMap<string, FramePromptVersion>;
  settingsEvents: readonly SequenceEvent[];
  sceneContext: ReadonlyMap<string, SceneContext>;
  /** What each shot says, for the motion hash (#1784). */
  dialogueOf: (shot: { id: string }) => ShotPromptDialogue;
  /** Input history for the causes, loaded once and only when one is stale. */
  inputHistory: () => Promise<InputHistory>;
};

/**
 * Every version of the inputs with history (#1600) — bibles by parent row id,
 * scene versions by scene id — oldest first.
 */
type InputHistory = {
  characters: ReadonlyMap<string, readonly CharacterBibleVersion[]>;
  locations: ReadonlyMap<string, readonly LocationBibleVersion[]>;
  scenes: ReadonlyMap<string, readonly SceneScriptVersion[]>;
  style: readonly SequenceStyleVersion[];
  /** When each shot's current lines were selected (#1784). */
  dialogueSelectedAt: ReadonlyMap<string, Date>;
};

type InputHistoryDb = {
  characters: Pick<ScopedDb['characters'], 'listBibleVersionsBySequence'>;
  sequenceLocations: Pick<
    ScopedDb['sequenceLocations'],
    'listBibleVersionsBySequence'
  >;
  sceneScriptVersions: Pick<ScopedDb['sceneScriptVersions'], 'listBySequence'>;
  sequences: Pick<ScopedDb['sequences'], 'listStyleVersions'>;
  shotDialogue: Pick<ScopedDb['shotDialogue'], 'getSelectedBySequence'>;
};

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list) list.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}

async function loadInputHistory(
  scopedDb: InputHistoryDb,
  sequenceId: string
): Promise<InputHistory> {
  const [characters, locations, scenes, style, dialogue] = await Promise.all([
    scopedDb.characters.listBibleVersionsBySequence(sequenceId),
    scopedDb.sequenceLocations.listBibleVersionsBySequence(sequenceId),
    scopedDb.sceneScriptVersions.listBySequence(sequenceId),
    scopedDb.sequences.listStyleVersions(sequenceId),
    scopedDb.shotDialogue.getSelectedBySequence(sequenceId),
  ]);
  return {
    characters: groupBy(characters, (v) => v.characterId),
    locations: groupBy(locations, (v) => v.locationId),
    scenes: groupBy(
      scenes.map((row) => row.version),
      (v) => v.sceneId
    ),
    style,
    dialogueSelectedAt: new Map(
      dialogue.flatMap((v) => (v.selectedAt ? [[v.shotId, v.selectedAt]] : []))
    ),
  };
}

export async function loadShotStalenessReads(
  scopedDb: Pick<
    ScopedDb,
    | 'framePromptVersions'
    | 'shotPromptVersions'
    | 'frameVariants'
    | 'sequenceEvents'
    | 'shotDialogue'
  > &
    InputHistoryDb,
  sequenceId: string,
  /** Every shot of the sequence — the dialogue first-shot rule needs them. */
  shots: Parameters<typeof shotPromptDialogueResolver>[0]['shots'],
  shotIds: readonly string[],
  frameIds: readonly string[],
  sceneContext: ReadonlyMap<string, SceneContext>
): Promise<ShotStalenessReads> {
  const [
    selectedPromptByFrame,
    latestPromptByFrame,
    latestHashedPromptByFrame,
    selectedMotionByShot,
    latestMotionByShot,
    latestHashedMotionByShot,
    liveVisualClaimsByFrame,
    liveMotionClaimsByShot,
    liveImageClaimsByFrame,
    settingsEvents,
    linesByShotId,
  ] = await Promise.all([
    scopedDb.framePromptVersions.getSelectedByFrameIds([...frameIds]),
    scopedDb.framePromptVersions.getLatestByFrameIds([...frameIds]),
    scopedDb.framePromptVersions.getLatestWithInputHashByFrameIds([
      ...frameIds,
    ]),
    scopedDb.shotPromptVersions.getSelectedMotionByShots([...shotIds]),
    scopedDb.shotPromptVersions.getLatestMotionByShotIds([...shotIds]),
    scopedDb.shotPromptVersions.getLatestMotionWithInputHashByShotIds([
      ...shotIds,
    ]),
    scopedDb.framePromptVersions.listLivePendingByFrameIds([...frameIds]),
    scopedDb.shotPromptVersions.listLiveMotionPendingByShotIds([...shotIds]),
    scopedDb.frameVariants.listLiveClaimsByFrameIds([...frameIds]),
    scopedDb.sequenceEvents.listBySequence(sequenceId, {
      kind: SETTINGS_CHANGED_EVENT,
    }),
    loadShotDialogueLines(scopedDb, sequenceId),
  ]);

  const dependIds = new Set<string>();
  for (const claims of liveImageClaimsByFrame.values()) {
    for (const claim of claims) {
      if (claim.dependsOnVersionId) dependIds.add(claim.dependsOnVersionId);
    }
  }
  const promptById = new Map<string, FramePromptVersion>();
  if (dependIds.size > 0) {
    for (const row of await scopedDb.framePromptVersions.getByIds([
      ...dependIds,
    ])) {
      promptById.set(row.id, row);
    }
  }

  let inputHistory: Promise<InputHistory> | null = null;
  return {
    inputHistory: () =>
      (inputHistory ??= loadInputHistory(scopedDb, sequenceId)),
    selectedPromptByFrame,
    latestPromptByFrame,
    latestHashedPromptByFrame,
    selectedMotionByShot,
    latestMotionByShot,
    latestHashedMotionByShot,
    liveVisualClaimsByFrame,
    liveMotionClaimsByShot,
    liveImageClaimsByFrame,
    promptById,
    settingsEvents,
    sceneContext,
    dialogueOf: shotPromptDialogueResolver({
      linesByShotId,
      shots,
      legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
      scriptDialogueOf: (sceneId) =>
        sceneContext.get(sceneId)?.script?.dialogue,
    }),
  };
}

/** Rows are newest-first (`orderBy createdAt desc`). */
function newestPending<T extends { pendingInputHash: string | null }>(
  rows: readonly T[] | undefined,
  hash: string
): T | null {
  return rows?.find((row) => row.pendingInputHash === hash) ?? null;
}

/**
 * Five states per artifact:
 *   - `'stale'`     — stored hash diverges from the freshly computed one.
 *   - `'fresh'`     — stored hash matches.
 *   - `'updating'`  — stored hash diverges, but a live pending claim matches
 *                     the live hash — a job is already fixing exactly this
 *                     (see the overlay at the end of this function, #1085).
 *   - `'untracked'` — no stored hash (legacy artifact, or never generated).
 *                     Distinct from `'fresh'` so the UI can suppress the
 *                     regenerate prompt without lying about the artifact's
 *                     freshness.
 *   - `'generating'`— the sequence is mid-generation run (#1121); see the
 *                     early return below.
 *   - `'unknown'`   — the comparison itself failed (style deleted mid-flight,
 *                     transient D1 read, malformed row). Distinct from
 *                     `'untracked'`: the UI renders it as "couldn't check"
 *                     rather than as silence, so a broken comparison never
 *                     reads as "up to date". WRITE paths must not treat "we
 *                     couldn't tell" as "nothing to do" — `computePlan`
 *                     (update-stale-plan) reports these as skipped rather than
 *                     silently dropping a possibly-stale artifact.
 *
 * `refs` lets batched callers load the sequence-scoped rows once for the whole
 * scene/sequence instead of once per shot; when absent they are loaded lazily.
 */
export async function computeShotStaleness(args: {
  scopedDb: ScopedDb;
  sequence: Omit<ShotPromptContextSequence, 'referenceOnly'> &
    StartFrameSequence & {
      aspectRatio: AspectRatio;
      status: SequenceStatus;
    };
  shot: Shot;
  frame: Frame;
  /**
   * The `frame_variants` row the frame's selection points at — the still's
   * url / model / inputHash live there since #1067, not on the frame. Passed in
   * (not looked up here) so the batch caller resolves them all in one read.
   */
  selectedImage: FrameVariant | null;
  scene: Scene | null;
  refs?: ShotStalenessRefs;
  /**
   * What the shot says now and whether it sits on its dialogue node
   * (#1784) — the motion prompt hash reads the shot's lines, not the
   * script's. Batch callers take it from `reads.dialogueOf`.
   */
  dialogue: ShotPromptDialogue;
  /**
   * Sequence-wide rows from `loadShotStalenessReads`. When set, this shot
   * does not query prompt versions, claims, or settings events itself.
   */
  reads?: ShotStalenessReads;
}): Promise<ShotStalenessResult> {
  const {
    scopedDb,
    sequence,
    shot,
    frame,
    selectedImage,
    scene,
    refs,
    reads,
    dialogue,
  } = args;
  // A shot may override the sequence's start-frame mode, and the motion hash
  // folds that flag in. Recomputing the live hash from the SEQUENCE value would
  // never match the stamp an overridden shot was written with, leaving it
  // reported stale for ever. The still is withheld for the same reason: a shot
  // rendering reference-only did not hash one.
  const motionSequence = {
    ...sequence,
    referenceOnly: rendersReferenceOnly(shot, sequence),
  };
  const motionStartingFrameUrl = motionSequence.referenceOnly
    ? null
    : (selectedImage?.url ?? null);

  // ============================================================
  // Mid-run short-circuit (#1121). Every comparison below pits a hash stamped
  // at some earlier moment against one recomputed from live scoped state. That
  // is only a statement about the user's edits once the sequence has settled:
  // during a storyboard run the inputs the hashes are taken over — cast rows,
  // locations, elements, and therefore the narrowed bibles
  // `loadNarrowShotPromptContext` derives — are still being written, so a
  // prompt stamped against the context of five minutes ago legitimately
  // diverges from the context of now, and the run itself is what closes the
  // gap (the pipeline writes a final version against the settled context,
  // which is why the banner used to clear on its own at the end).
  //
  // Reporting that as 'stale' told the user "out of date since your edit" when
  // they had not edited anything, and offered "Update all" — regenerating,
  // for real money, artifacts the running pipeline was about to overwrite.
  // 'generating' is the honest answer: no verdict, no action, and the client
  // predicates (`shotIsStale`/`shotIsUpdating`/`shotStalenessUnknown`) all
  // ignore it, so nothing renders. Returned BEFORE any read: the batch fn
  // recomputes hashes for every shot in the sequence on a poll loop that runs
  // hardest during exactly this window.
  // ============================================================
  if (isSequenceGenerating(sequence.status)) return GENERATING_STALENESS;

  const liveHashes: ShotLiveHashes = {
    thumbnail: null,
    visualPrompt: null,
    motionPrompt: null,
  };
  let thumbnail: ArtifactStaleness = 'untracked';
  const selectedPrompt = reads
    ? (reads.selectedPromptByFrame.get(frame.id) ?? null)
    : await scopedDb.framePromptVersions.getSelected(frame.id);
  const effectivePrompt = selectedPrompt?.text ?? null;
  if (effectivePrompt) {
    // Null stored hash: 'untracked' (no opinion), unless a named element's
    // row is newer than the still — replace would otherwise hide it (#1192).
    if (selectedImage?.inputHash == null && !selectedImage?.url) {
      thumbnail = 'untracked';
    } else {
      try {
        const [characters, locations, elements] = refs
          ? [refs.characters, refs.locations, refs.elements]
          : await Promise.all([
              scopedDb.characters.listWithSheets(sequence.id),
              scopedDb.sequenceLocations.listWithReferences(sequence.id),
              scopedDb.sequenceElements.list(sequence.id),
            ]);

        if (selectedImage.inputHash == null) {
          thumbnail = 'untracked';
          const matched = matchElementsToShotImage(elements, {
            visualPrompt: effectivePrompt,
            elementTags: scene?.continuity?.elementTags,
            sceneExtract: scene?.originalScript.extract,
          });
          const stillAt = (
            selectedImage.generatedAt ?? selectedImage.createdAt
          ).getTime();
          if (matched.some((el) => el.updatedAt.getTime() > stillAt)) {
            thumbnail = 'stale';
          }
        }

        const snapshot = await buildRegenerateShotSnapshot({
          shot,
          scene,
          frameId: frame.id,
          imagePrompt: effectivePrompt,
          characters,
          locations,
          elements,
          imageModel: safeTextToImageModel(
            selectedImage.model,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
        });
        liveHashes.thumbnail = snapshot.snapshotInputHash;
        if (selectedImage.inputHash != null) {
          thumbnail =
            snapshot.snapshotInputHash !== selectedImage.inputHash
              ? 'stale'
              : 'fresh';
        }
      } catch (error) {
        // Fail-open as 'fresh' would lie. Don't clobber a timestamp-stale
        // verdict if only the snapshot hash failed.
        if (thumbnail !== 'stale') thumbnail = 'unknown';
        logger.warn(`thumbnail staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  let visualPrompt: ArtifactStaleness = 'untracked';
  let motionPrompt: ArtifactStaleness = 'untracked';
  // Legacy digests ignore the voice-only flag; verify asks whether one moved
  // since the stamp (#1787). Read only when the current digest missed.
  const voiceOnlyMoved = async (at: Date) =>
    voiceOnlyMovedSince(
      reads
        ? [...(await reads.inputHistory()).characters.values()].flat()
        : await scopedDb.characters.listBibleVersionsBySequence(sequence.id),
      at
    );
  let selectedMotion: { inputHash: string | null; createdAt: Date } | null =
    null;

  // Reference hash resolution: prefer the SELECTED version's `inputHash`, but
  // fall back to the most recent version with a non-null one for prompts whose
  // selected row carries a null hash (a pre-fix user-edit, or the force-regen
  // path). Without the fallback, those are stuck at `'untracked'` permanently.
  if (scene) {
    // The fallback read is inside the try: it is exactly the transient-D1 case
    // the catch exists for, and outside it one bad read rejects the caller's
    // whole batch.
    try {
      let reference = selectedPrompt?.inputHash ? selectedPrompt : null;
      if (!reference) {
        reference = reads
          ? (reads.latestHashedPromptByFrame.get(frame.id) ?? null)
          : await scopedDb.framePromptVersions.getLatestWithInputHash(frame.id);
      }
      const referenceHash = reference?.inputHash ?? null;
      if (referenceHash) {
        const latest = reads
          ? (reads.latestPromptByFrame.get(frame.id) ?? null)
          : await scopedDb.framePromptVersions.getLatest(frame.id);
        const ctx = await loadNarrowShotPromptContext({
          scopedDb,
          sequence: motionSequence,
          scene,
          analysisModelOverride: latest?.analysisModel ?? null,
          refs,
        });
        const liveHash = await hashVisualPromptInput(ctx);
        liveHashes.visualPrompt = liveHash;
        // Fresh prompts match the current digest. Legacy digests are only
        // hashed when it doesn't — the common editor load is the match.
        visualPrompt =
          referenceHash === liveHash ||
          (await visualPromptInputHashMatches(referenceHash, ctx, {
            voiceOnlyMoved: await voiceOnlyMoved(
              reference?.createdAt ?? new Date(0)
            ),
          }))
            ? 'fresh'
            : 'stale';
      }
    } catch (error) {
      // Context unavailable (e.g., style deleted mid-flight). Report
      // 'unknown' — fail-open as 'fresh' would silently lie to the user.
      visualPrompt = 'unknown';
      if (error instanceof z.ZodError) {
        // A ZodError here is a corrupt style/scene row — a permanent defect
        // that would otherwise warn quietly on every poll forever.
        logger.error(`corrupt prompt context for shot ${shot.id}:`, {
          err: error,
        });
      } else {
        logger.warn(`visual staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  if (scene) {
    try {
      selectedMotion = reads
        ? (reads.selectedMotionByShot.get(shot.id) ?? null)
        : await scopedDb.shotPromptVersions.getSelectedMotion(shot.id);
      let reference = selectedMotion?.inputHash ? selectedMotion : null;
      if (!reference) {
        reference = reads
          ? (reads.latestHashedMotionByShot.get(shot.id) ?? null)
          : await scopedDb.shotPromptVersions.getLatestWithInputHash(
              shot.id,
              'motion'
            );
      }
      const referenceHash = reference?.inputHash ?? null;
      if (referenceHash) {
        const latest = reads
          ? (reads.latestMotionByShot.get(shot.id) ?? null)
          : await scopedDb.shotPromptVersions.getLatest(shot.id, 'motion');
        const ctx = {
          ...(await loadNarrowShotPromptContext({
            scopedDb,
            sequence: motionSequence,
            scene,
            analysisModelOverride: latest?.analysisModel ?? null,
            startingFrameImageUrl: motionStartingFrameUrl,
            refs,
          })),
          dialogue: dialogue.dialogue,
        };
        const liveHash = await hashMotionPromptInput(ctx);
        liveHashes.motionPrompt = liveHash;
        motionPrompt =
          referenceHash === liveHash ||
          (await motionPromptInputHashMatches(referenceHash, ctx, {
            legacyScriptDialogue: !dialogue.onNode,
            voiceOnlyMoved: await voiceOnlyMoved(
              reference?.createdAt ?? new Date(0)
            ),
          }))
            ? 'fresh'
            : 'stale';
      }
    } catch (error) {
      motionPrompt = 'unknown';
      if (error instanceof z.ZodError) {
        logger.error(`corrupt prompt context for shot ${shot.id}:`, {
          err: error,
        });
      } else {
        logger.warn(`motion staleness uncomputable for shot ${shot.id}:`, {
          err: error,
        });
      }
    }
  }

  // ============================================================
  // 'updating' overlay (#1085): a stale artifact with a live pending claim
  // whose pendingInputHash equals the live hash is already being fixed.
  // Runs last so the thumbnail's chained-claim check can use the visual
  // prompt's live hash computed above.
  // ============================================================
  if (visualPrompt === 'stale' && liveHashes.visualPrompt) {
    const claim = reads
      ? newestPending(
          reads.liveVisualClaimsByFrame.get(frame.id),
          liveHashes.visualPrompt
        )
      : await scopedDb.framePromptVersions.getLivePending(
          frame.id,
          liveHashes.visualPrompt
        );
    if (claim) visualPrompt = 'updating';
  }
  if (motionPrompt === 'stale' && liveHashes.motionPrompt) {
    const claim = reads
      ? newestPending(
          reads.liveMotionClaimsByShot.get(shot.id),
          liveHashes.motionPrompt
        )
      : await scopedDb.shotPromptVersions.getLivePending(
          shot.id,
          liveHashes.motionPrompt
        );
    if (claim) motionPrompt = 'updating';
  }
  if (thumbnail === 'stale' && liveHashes.thumbnail) {
    const claims = reads
      ? (reads.liveImageClaimsByFrame.get(frame.id) ?? [])
      : await scopedDb.frameVariants.listLiveClaims(frame.id);
    for (const claim of claims) {
      // Direct regen: the claim satisfies the image's live hash itself.
      if (claim.pendingInputHash === liveHashes.thumbnail) {
        thumbnail = 'updating';
        break;
      }
      // Chained regen: validity derives from the dependency prompt row. While
      // the prompt is in flight its claim must match the live VISUAL hash;
      // once it completes (render still pending/running) its stamped
      // inputHash must — either way an edit moves the live hash and honestly
      // re-stales the image.
      if (claim.dependsOnVersionId && liveHashes.visualPrompt) {
        const dep = reads
          ? (reads.promptById.get(claim.dependsOnVersionId) ?? null)
          : await scopedDb.framePromptVersions.getByIdForFrame(
              claim.dependsOnVersionId,
              frame.id
            );
        if (reads && dep && dep.frameId !== frame.id) continue;
        if (!dep) continue;
        const depInFlight =
          (dep.status === 'pending' || dep.status === 'generating') &&
          dep.pendingInputHash === liveHashes.visualPrompt;
        const depLanded =
          dep.status === 'completed' &&
          dep.inputHash === liveHashes.visualPrompt;
        if (depInFlight || depLanded) {
          thumbnail = 'updating';
          break;
        }
      }
    }
  }

  let causes: string[] = [];
  if ([thumbnail, visualPrompt, motionPrompt].includes('stale')) {
    try {
      const resolvedRefs: ShotStalenessRefs = refs ?? {
        characters: await scopedDb.characters.listWithSheets(sequence.id),
        locations: await scopedDb.sequenceLocations.listWithReferences(
          sequence.id
        ),
        elements: await scopedDb.sequenceElements.list(sequence.id),
        style: sequence.styleId
          ? await scopedDb.styles.getById(sequence.styleId)
          : null,
      };
      causes = await findStalenessCauses({
        scopedDb,
        sequence,
        shot,
        refs: resolvedRefs,
        selectedImage,
        sceneContext: reads?.sceneContext,
        settingsEvents: reads?.settingsEvents,
        inputHistory: reads
          ? await reads.inputHistory()
          : await loadInputHistory(scopedDb, sequence.id),
        generatedAt: {
          thumbnail:
            thumbnail === 'stale' && selectedImage
              ? (selectedImage.generatedAt ?? selectedImage.createdAt)
              : undefined,
          visualPrompt:
            visualPrompt === 'stale' ? selectedPrompt?.createdAt : undefined,
          motionPrompt:
            motionPrompt === 'stale' ? selectedMotion?.createdAt : undefined,
        },
      });
    } catch (error) {
      // A hint, never a verdict: an unreadable row just leaves it unnamed.
      logger.warn(`staleness causes uncomputable for shot ${shot.id}:`, {
        err: error,
      });
    }
  }

  return { thumbnail, visualPrompt, motionPrompt, liveHashes, causes };
}

const after = (d: Date | null | undefined, at: number) =>
  d != null && d.getTime() > at;

/** Plain words for the bible fields a cause names (#1600). */
const CHARACTER_LABELS: Record<keyof CharacterBible, string> = {
  name: 'name',
  age: 'age',
  gender: 'gender',
  ethnicity: 'ethnicity',
  physicalDescription: 'description',
  standardClothing: 'clothing',
  distinguishingFeatures: 'features',
  personality: 'personality',
  movement: 'movement',
  voiceOnly: 'voice only',
  isPerson: 'person',
  consistencyTag: 'tag',
};

const LOCATION_LABELS: Record<keyof LocationBible, string> = {
  name: 'name',
  type: 'interior/exterior',
  timeOfDay: 'time of day',
  description: 'description',
  architecturalStyle: 'architecture',
  keyFeatures: 'features',
  colorPalette: 'palette',
  lightingSetup: 'lighting',
  ambiance: 'ambiance',
  consistencyTag: 'tag',
};

/**
 * The bible fields that moved since `at` (#1600): the version live then —
 * the newest created at or before it — against the live bible. Null when no
 * version reaches back that far (an artifact older than the row's history),
 * so the caller falls back to the timestamp guess.
 */
function bibleMoved<V extends { createdAt: Date }>(
  history: readonly V[] | undefined,
  at: number,
  diff: (then: V) => string[]
): string[] | null {
  let then: V | undefined;
  for (const v of history ?? []) {
    if (v.createdAt.getTime() <= at) then = v;
  }
  return then ? diff(then) : null;
}

/** Plain words for the style knobs a cause names (the hash body's keys). */
const STYLE_LABELS: Record<string, string> = {
  mood: 'mood',
  artStyle: 'art style',
  lighting: 'lighting',
  colorPalette: 'palette',
  cameraWork: 'camera',
  referenceFilms: 'references',
  colorGrading: 'grading',
  medium: 'medium',
  shots: 'shots',
  pace: 'pace',
  energy: 'energy',
};

/**
 * The style knobs that moved since `at` (#1600): the snapshot live then
 * against the live one, compared over the same body the hashes read. Null
 * when no snapshot reaches back that far, or either side is unreadable.
 */
function styleMoved(
  history: readonly SequenceStyleVersion[],
  live: unknown,
  at: number
): string[] | null {
  let then: SequenceStyleVersion | undefined;
  for (const v of history) {
    if (v.createdAt.getTime() <= at) then = v;
  }
  if (!then || live == null) return null;
  try {
    const before = styleConfigHashBody(parseStyleConfig(then.config)) ?? {};
    const after = styleConfigHashBody(parseStyleConfig(live)) ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys]
      .filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
      )
      .map((key) => STYLE_LABELS[key] ?? key);
  } catch {
    return null;
  }
}

/** Plain words for the scene fields a cause names; the title is a label. */
const SCENE_LABELS: Partial<Record<keyof SceneNarrative, string>> = {
  location: 'heading',
  timeOfDay: 'time of day',
  storyBeat: 'story beat',
  continuity: 'cast and tags',
};

async function loadSceneContext(
  scopedDb: Pick<ScopedDb, 'scenes' | 'sceneScriptVersions'>,
  sceneId: DbSceneId
): Promise<SceneContext | null> {
  const [scene, script] = await Promise.all([
    scopedDb.scenes.getById(sceneId),
    scopedDb.sceneScriptVersions.getSelected(sceneId),
  ]);
  return scene
    ? {
        scene,
        script: script?.content ?? null,
        scriptCreatedAt: script?.createdAt ?? null,
      }
    : null;
}

/**
 * What moved in the shot's scene since `at` (#1600): the scene version live
 * then against the live one — `Script` for its text or lines, `Scene: …`
 * for the narrative. A scene whose history does not reach back that far falls
 * back to the timestamp guess.
 */
function sceneCauses(
  history: readonly SceneScriptVersion[] | undefined,
  live: SceneContext,
  at: number
): string[] {
  let then: SceneScriptVersion | undefined;
  for (const v of history ?? []) {
    if (v.createdAt.getTime() <= at) then = v;
  }
  if (!then) {
    if (after(live.scriptCreatedAt, at)) return ['Script'];
    return after(live.scene.updatedAt, at) ? ['Scene details'] : [];
  }
  const causes: string[] = [];
  const script = live.script ?? { extract: '', dialogue: [] };
  if (
    then.content.extract !== script.extract ||
    JSON.stringify(then.content.dialogue) !== JSON.stringify(script.dialogue)
  ) {
    causes.push('Script');
  }
  const moved = narrativeFieldsChanged(
    sceneNarrativeOf(then),
    sceneNarrativeOf(live.scene)
  ).flatMap((key) => {
    const label = SCENE_LABELS[key];
    return label ? [label] : [];
  });
  if (moved.length > 0) causes.push(`Scene: ${moved.join(', ')}`);
  // A backfilled version holds the narrative of the #1600 deploy day, not of
  // when it was live, so "nothing moved" is unknowable: guess from the time.
  else if (then.narrativeBackfilled && after(live.scene.updatedAt, at)) {
    causes.push('Scene details');
  }
  return causes;
}

/** `Character "Jack": clothing, sheet` — or the bare label when unknown. */
function namedCause(
  label: string,
  moved: string[] | null,
  extra: string[],
  touched: () => boolean
): string | null {
  if (moved === null) return touched() || extra.length > 0 ? label : null;
  const fields = [...moved, ...extra];
  return fields.length > 0 ? `${label}: ${fields.join(', ')}` : null;
}

/**
 * Name what moved since the stale artifact was generated (#1194). Hashes only
 * say THAT inputs diverged. Bibles have history (#1600), so a character or
 * location names the fields that differ between the version live then and
 * now; everything else is still a timestamp guess — every input row touched
 * after the artifact is a candidate. A hint, never a verdict.
 */
async function findStalenessCauses(args: {
  scopedDb: ScopedDb;
  sequence: { id: string; styleConfig?: unknown };
  shot: Shot;
  refs: ShotStalenessRefs;
  /** When each stale artifact was generated; absent → that artifact isn't stale. */
  generatedAt: { thumbnail?: Date; visualPrompt?: Date; motionPrompt?: Date };
  selectedImage: FrameVariant | null;
  /** Present on the batched read — skips the per-shot scene and event queries. */
  sceneContext?: ReadonlyMap<string, SceneContext>;
  settingsEvents?: readonly SequenceEvent[];
  inputHistory: InputHistory;
}): Promise<string[]> {
  const {
    scopedDb,
    sequence,
    shot,
    refs,
    generatedAt,
    selectedImage,
    sceneContext,
    settingsEvents,
    inputHistory,
  } = args;
  const times = [
    generatedAt.thumbnail,
    generatedAt.visualPrompt,
    generatedAt.motionPrompt,
  ].flatMap((d) => (d ? [d.getTime()] : []));
  if (times.length === 0) return [];
  const at = Math.min(...times);
  const causes: string[] = [];

  if (shot.sceneId) {
    const sceneId = dbSceneId(shot.sceneId);
    const ctx = sceneContext
      ? sceneContext.get(sceneId)
      : await loadSceneContext(scopedDb, sceneId);
    if (ctx)
      causes.push(...sceneCauses(inputHistory.scenes.get(sceneId), ctx, at));
  }

  const events =
    settingsEvents ??
    (await scopedDb.sequenceEvents.listByTarget('sequence', sequence.id));
  const fields = new Set<string>();
  for (const e of events) {
    if (e.kind !== SETTINGS_CHANGED_EVENT || !after(e.createdAt, at)) continue;
    const changed = e.data?.fields;
    if (Array.isArray(changed)) {
      for (const f of changed) if (typeof f === 'string') fields.add(f);
    }
  }
  // A snapshot with history names the knobs that moved (#1600) in place of
  // the bare "Style" a switch event would give.
  const styleKnobs = styleMoved(inputHistory.style, sequence.styleConfig, at);
  // Older events also list model switches, which never stale (#1785).
  for (const f of fields) {
    if (f === 'styleId' && styleKnobs !== null) continue;
    const label = SETTINGS_CHANGED_LABELS[f];
    if (label) causes.push(label);
  }
  if (styleKnobs && styleKnobs.length > 0) {
    causes.push(`Style: ${styleKnobs.join(', ')}`);
  }
  // Catalog style edits only flow through when the sequence has no snapshot.
  if (sequence.styleConfig == null && after(refs.style?.updatedAt, at)) {
    if (!fields.has('styleId')) causes.push('Style');
  }

  for (const c of refs.characters) {
    const moved = bibleMoved(inputHistory.characters.get(c.id), at, (then) =>
      characterBibleChanged(then, c).map((k) => CHARACTER_LABELS[k])
    );
    const sheet = after(c.sheetGeneratedAt, at) ? ['sheet'] : [];
    const cause = namedCause(`Character "${c.name}"`, moved, sheet, () =>
      after(c.updatedAt, at)
    );
    if (cause) causes.push(cause);
  }
  for (const l of refs.locations) {
    const moved = bibleMoved(inputHistory.locations.get(l.id), at, (then) =>
      locationBibleChanged(then, l).map((k) => LOCATION_LABELS[k])
    );
    const sheet = after(l.referenceGeneratedAt, at) ? ['sheet'] : [];
    const cause = namedCause(`Location "${l.name}"`, moved, sheet, () =>
      after(l.updatedAt, at)
    );
    if (cause) causes.push(cause);
  }
  for (const el of refs.elements) {
    if (after(el.updatedAt, at)) causes.push(`Element ${el.token}`);
  }
  const motionAt = generatedAt.motionPrompt?.getTime();
  if (motionAt !== undefined) {
    if (after(inputHistory.dialogueSelectedAt.get(shot.id), motionAt)) {
      causes.push('Dialogue');
    }
    if (
      after(selectedImage?.generatedAt ?? selectedImage?.createdAt, motionAt)
    ) {
      causes.push('Image re-rendered');
    }
  }
  return causes;
}
