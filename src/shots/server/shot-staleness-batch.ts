import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { getLogger } from '@/platform/logger';
import { typedFromEntries } from '@/platform/typed-object';
import { resolveSceneForShot } from '@/shots/server/scene-script';
import {
  loadShotMediaStaleness,
  overlayMediaStaleness,
} from '@/shots/server/shot-media-staleness';
import {
  computeShotStaleness,
  GENERATING_STALENESS,
  loadShotStalenessReads,
  loadShotStalenessRefs,
  UNTRACKED_STALENESS,
  type ShotStalenessResult,
} from '@/shots/server/shot-staleness';

const logger = getLogger(['openstory', 'shots', 'shot-staleness-batch']);

/**
 * The client-facing slice of a staleness result. `liveHashes` is a server-side
 * convenience for the enqueue paths (#1085) and stays off the wire.
 */
const toWireStaleness = (
  result: ShotStalenessResult,
  media?: {
    dialogue: ShotStalenessResult['thumbnail'];
    video: ShotStalenessResult['thumbnail'];
  }
) => {
  const overlaid = overlayMediaStaleness(result, media);
  return {
    thumbnail: overlaid.thumbnail,
    visualPrompt: overlaid.visualPrompt,
    motionPrompt: overlaid.motionPrompt,
    dialogue: overlaid.dialogue,
    video: overlaid.video,
    causes: overlaid.causes,
  };
};

/**
 * Staleness of `targetShots`, keyed by shot id, from reads loaded once for
 * the sequence (#1795, #2234): both staleness fns share it, so a single shot
 * costs the same few round trips as a whole scene.
 */
export async function loadStalenessForShots(
  scopedDb: ScopedDb,
  sequence: Parameters<typeof computeShotStaleness>[0]['sequence'],
  allShots: Shot[],
  targetShots: Shot[]
) {
  // Mid-run the per-shot compare returns 'generating' before any read, and
  // the media overlay then forces dialogue and video to the same. Skip the
  // bible, prompt, and segment loads entirely (#1121, #1795).
  if (sequence.status === 'processing') {
    return typedFromEntries(
      targetShots.map((shot) => [
        shot.id,
        toWireStaleness(GENERATING_STALENESS),
      ])
    );
  }

  // Loaded once here and threaded into every shot's comparison; without
  // that each shot would re-read the bibles for both prompt branches.
  const allShotIds = allShots.map((shot) => shot.id);
  const loadBase = () =>
    Promise.all([
      loadShotStalenessRefs(scopedDb, sequence),
      scopedDb.shotDialogue.listShotIdsWithLiveClaim(allShotIds),
    ]);
  let [loaded, recording] = await loadBase();
  const missingAnchors = targetShots.filter(
    (shot) => !loaded.anchorsByShot.has(shot.id)
  );
  if (missingAnchors.length > 0) {
    await scopedDb.shots.ensureAnchorFrames(missingAnchors);
    [loaded, recording] = await loadBase();
  }
  const { anchorsByShot, sceneContext: scriptBySceneId, refs } = loaded;
  const frameIds = targetShots.flatMap((shot) => {
    const frame = anchorsByShot.get(shot.id);
    return frame ? [frame.id] : [];
  });
  // The stills, the prompts and the media read nothing from each other.
  const [selectedByFrame, reads, media] = await Promise.all([
    scopedDb.frameVariants.getSelectedByFrameIds(frameIds),
    loadShotStalenessReads(
      scopedDb,
      sequence.id,
      allShots,
      targetShots.map((shot) => shot.id),
      frameIds,
      scriptBySceneId
    ),
    loadShotMediaStaleness(scopedDb, sequence, allShots, {
      sceneContext: scriptBySceneId,
      characters: refs.characters,
      elements: refs.elements,
      recording,
    }),
  ]);

  const entries = await Promise.all(
    targetShots.map(
      async (shot): Promise<[string, ReturnType<typeof toWireStaleness>]> => {
        const frame = anchorsByShot.get(shot.id);
        if (!frame) {
          // ensureAnchorFrames guarantees an anchor; if it's somehow absent
          // we have no image surface to compare, so report the shot
          // untracked rather than dropping it from the result.
          logger.error(
            `loadStalenessForShots: shot ${shot.id} has no anchor frame`
          );
          return [
            shot.id,
            toWireStaleness(UNTRACKED_STALENESS, media.get(shot.id)),
          ];
        }
        const { scene } = resolveSceneForShot(shot, scriptBySceneId);
        try {
          return [
            shot.id,
            toWireStaleness(
              await computeShotStaleness({
                scopedDb,
                sequence,
                shot,
                frame,
                selectedImage: selectedByFrame.get(frame.id) ?? null,
                scene,
                refs,
                reads,
                dialogue: reads.dialogueOf(shot),
              }),
              media.get(shot.id)
            ),
          ];
        } catch (error) {
          // Per-shot boundary: one shot must not blank a scene; a single shot fails as itself.
          if (targetShots.length === 1) throw error;
          logger.error(
            `loadStalenessForShots: shot ${shot.id} staleness failed`,
            { err: error }
          );
          return [
            shot.id,
            toWireStaleness(UNTRACKED_STALENESS, media.get(shot.id)),
          ];
        }
      }
    )
  );
  return typedFromEntries(entries);
}
