import { audioSourceKeyForDialogueLines } from '@/motion/dialogue-tts';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { assembleSequenceSegments } from '@/shots/scene-segments';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import {
  rendersReferenceOnly,
  type StartFrameSequence,
} from '@/shots/use-start-frame';

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
  shots: readonly Shot[]
) {
  const [segments, versions, frames, scriptBySceneId, characters] =
    await Promise.all([
      scopedDb.renderSegments.listBySequence(sequence.id),
      scopedDb.videoVariants.listBySequence(sequence.id),
      scopedDb.frames.listBySequence(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
      scopedDb.characters.list(sequence.id),
    ]);
  const currentAudioSourceKeyByShot = new Map<string, string | null>();
  for (const shot of shots) {
    const { scene } = resolveSceneForShot(shot, scriptBySceneId);
    currentAudioSourceKeyByShot.set(
      shot.id,
      scene
        ? audioSourceKeyForDialogueLines(
            scene.originalScript?.dialogue,
            characters
          )
        : null
    );
  }
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
    currentAudioSourceKeyByShot,
  });
  return { assembled, versions };
}
