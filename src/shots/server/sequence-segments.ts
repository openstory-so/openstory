import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { assembleSequenceSegments } from '@/shots/scene-segments';
import {
  liveShotInputs,
  loadLiveShotReads,
} from '@/shots/server/live-shot-state';
import {
  loadSceneContextBySequence,
  type SceneContext,
} from '@/shots/server/scene-script';
import {
  rendersReferenceOnly,
  type StartFrameSequence,
} from '@/shots/use-start-frame';

/** Reads the caller already made, so the loader skips them. */
export type SequenceSegmentsShared = {
  sceneContext: ReadonlyMap<string, SceneContext>;
  characters: Awaited<ReturnType<ScopedDb['characters']['list']>>;
  elements: Awaited<ReturnType<ScopedDb['sequenceElements']['list']>>;
};

/**
 * Every render segment of a sequence, assembled with its staleness verdict.
 *
 * The one loader behind the Scenes editor, the update-stale plan and the MCP
 * staleness read, so they cannot disagree. `shots` must be EVERY live shot of
 * the sequence, not a segment's current members: a manifest entry is compared
 * against its shot's current pointers wherever that shot now lives, and a shot
 * missing from the maps reads as stale. A shot regrouped into a new segment
 * would otherwise mark its old segment's unchanged clip stale.
 */
export async function loadSequenceSegments(
  scopedDb: ScopedDb,
  sequence: StartFrameSequence & { id: string },
  shots: readonly Shot[],
  shared?: SequenceSegmentsShared
) {
  const [segments, versions, frames, sceneContext, characters, liveReads] =
    await Promise.all([
      scopedDb.renderSegments.listBySequence(sequence.id),
      scopedDb.videoVariants.listBySequence(sequence.id),
      scopedDb.frames.listBySequence(sequence.id),
      shared?.sceneContext ?? loadSceneContextBySequence(scopedDb, sequence.id),
      shared?.characters ?? scopedDb.characters.list(sequence.id),
      loadLiveShotReads(scopedDb, sequence.id, shots, shared?.elements),
    ]);
  // What each shot would render from NOW beyond its two pointers (#1657):
  // dialogue key and clip ids, reference provenance, duration.
  const live = liveShotInputs(
    liveReads,
    shots,
    characters,
    sceneContext,
    sequence
  );
  // Versions are oldest-first here (listBySequence orders by ULID).
  const assembled = assembleSequenceSegments({
    segments,
    versions,
    // Resolved per shot, not per sequence: a shot can override the sequence's
    // start-frame mode either way, and staleness compares against what the
    // clip actually rendered from.
    shots: shots.map((shot) => ({
      ...shot,
      rendersReferenceOnly: rendersReferenceOnly(shot, sequence),
    })),
    frames,
    live,
  });
  return { assembled, versions, live };
}
