/**
 * Load per-shot dialogue and video ArtifactStaleness for the rail dots and
 * "Update all" (#1703). Same segment assembly the video chip uses, same clip
 * source-key match the readings list uses.
 */

import {
  dialogueArtifactStaleness,
  videoArtifactStaleness,
} from '@/shots/shot-media-staleness';
import type { ArtifactStaleness } from '@/shots/server/shot-staleness';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { loadSequenceSegments } from '@/shots/server/sequence-segments';
import type { StartFrameSequence } from '@/shots/use-start-frame';

export type ShotMediaStaleness = {
  dialogue: ArtifactStaleness;
  video: ArtifactStaleness;
};

function clipsMatchKey(
  clips: Shot['audioClips'],
  key: string | null | undefined
): boolean {
  if (!clips?.length || !key) return false;
  return clips.every((clip) => clip.sourceKey === key);
}

export async function loadShotMediaStaleness(
  scopedDb: ScopedDb,
  sequence: StartFrameSequence & { id: string },
  shots: readonly Shot[]
): Promise<Map<string, ShotMediaStaleness>> {
  const { assembled, versions, live } = await loadSequenceSegments(
    scopedDb,
    sequence,
    shots
  );

  const videoByShot = new Map<
    string,
    { hasVideo: boolean; alreadyStale: boolean; generating: boolean }
  >();
  for (const segment of assembled) {
    const generating = versions.some(
      (v) => v.renderSegmentId === segment.id && v.status === 'generating'
    );
    for (const shotId of segment.shotIds) {
      videoByShot.set(shotId, {
        hasVideo: segment.selectedVersion !== null,
        alreadyStale: segment.stale,
        generating,
      });
    }
  }

  const byShot = new Map<string, ShotMediaStaleness>();
  for (const shot of shots) {
    const key = live.audioSourceKeyByShot.get(shot.id) ?? null;
    const video = videoByShot.get(shot.id);
    byShot.set(shot.id, {
      dialogue: dialogueArtifactStaleness({
        voiced: key != null,
        hasAudio: (shot.audioClips?.length ?? 0) > 0,
        matching: clipsMatchKey(shot.audioClips, key),
      }),
      video: videoArtifactStaleness({
        hasVideo: video?.hasVideo ?? false,
        alreadyStale: video?.alreadyStale ?? false,
        generating: video?.generating ?? false,
      }),
    });
  }
  return byShot;
}

export function overlayMediaStaleness<
  T extends {
    thumbnail: ArtifactStaleness;
    visualPrompt: ArtifactStaleness;
    motionPrompt: ArtifactStaleness;
  },
>(result: T, media: ShotMediaStaleness | undefined): T & ShotMediaStaleness {
  if (
    result.thumbnail === 'generating' &&
    result.visualPrompt === 'generating' &&
    result.motionPrompt === 'generating'
  ) {
    return { ...result, dialogue: 'generating', video: 'generating' };
  }
  return {
    ...result,
    dialogue: media?.dialogue ?? 'untracked',
    video: media?.video ?? 'untracked',
  };
}
