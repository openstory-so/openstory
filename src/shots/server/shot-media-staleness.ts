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
import {
  loadSequenceSegments,
  type SequenceSegmentsShared,
} from '@/shots/server/sequence-segments';
import { loadVoiceMovedShotIds } from '@/shots/server/shot-dialogue';
import type { StartFrameSequence } from '@/shots/use-start-frame';

export type ShotMediaStaleness = {
  dialogue: ArtifactStaleness;
  video: ArtifactStaleness;
};

/** Reads the caller already made, and the shots with a speech in flight. */
export type ShotMediaShared = SequenceSegmentsShared & {
  recording: ReadonlySet<string>;
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
  shots: readonly Shot[],
  shared?: ShotMediaShared
): Promise<Map<string, ShotMediaStaleness>> {
  const states = await loadShotMediaStates(scopedDb, sequence, shots, shared);
  return new Map([...states].map(([id, state]) => [id, state.staleness]));
}

/**
 * The verdicts plus whether a clip render is in flight — `'updating'` only
 * covers a re-render, and the generation plan (#1816) needs the first one too.
 */
export async function loadShotMediaStates(
  scopedDb: ScopedDb,
  sequence: StartFrameSequence & { id: string },
  shots: readonly Shot[],
  shared?: ShotMediaShared
): Promise<
  Map<string, { staleness: ShotMediaStaleness; clipInFlight: boolean }>
> {
  // A voice change dates every shot recorded alongside it (#1802).
  const [{ assembled, versions, live }, voiceMoved, recording] =
    await Promise.all([
      loadSequenceSegments(scopedDb, sequence, shots, shared),
      loadVoiceMovedShotIds(scopedDb, sequence.id, shots),
      // A speech in flight that will become the shot's audio: updating, not
      // stale, so nothing offers to record it again meanwhile.
      shared?.recording ??
        scopedDb.shotDialogue.listShotIdsWithLiveClaim(
          shots.map((shot) => shot.id)
        ),
    ]);

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

  const byShot = new Map<
    string,
    { staleness: ShotMediaStaleness; clipInFlight: boolean }
  >();
  for (const shot of shots) {
    const key = live.audioSourceKeyByShot.get(shot.id) ?? null;
    const video = videoByShot.get(shot.id);
    byShot.set(shot.id, {
      clipInFlight: video?.generating ?? false,
      staleness: {
        dialogue: dialogueArtifactStaleness({
          voiced: key != null,
          hasAudio: (shot.audioClips?.length ?? 0) > 0,
          matching:
            clipsMatchKey(shot.audioClips, key) && !voiceMoved.has(shot.id),
          generating: recording.has(shot.id),
        }),
        video: videoArtifactStaleness({
          hasVideo: video?.hasVideo ?? false,
          alreadyStale: video?.alreadyStale ?? false,
          generating: video?.generating ?? false,
        }),
      },
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
