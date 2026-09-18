/**
 * Is a sequence's music TRACK out of date? (#1657)
 *
 * `MusicWorkflow` stamps `sequence_music_variants.inputHash` with
 * `computeSequenceMusicInputHash` over the prompt, tags, the duration the
 * generation was billed for and the audio model — but nothing ever compared
 * it back, so an edited or regenerated music prompt and changed shot
 * durations left the track silently stale. This is that comparison.
 *
 * A null stored hash is UNKNOWN, never stale — same contract as
 * `isSelectedVersionStale` and the variant-row comments: an uploaded score
 * (`setSequenceMusicFromUploadFn` writes `inputHash: null` on purpose) and a
 * pre-hash row cannot be proven out of date, and claiming they are would push
 * a regeneration over a track the user chose.
 */

import {
  getAudioModelDurationLimits,
  isValidAudioModel,
} from '@/models/models';
import { computeSequenceMusicInputHash } from '@/shots/input-hash';

export type MusicTrackStaleness = 'fresh' | 'stale' | 'untracked';

/**
 * Track length a regeneration asks for: shot durations, 10s each when unset,
 * 30s floor for an empty sequence (`generateMusicFn`'s rule). Rounded, so a
 * fractional sum hashes the same from the plan and from this read.
 */
export function musicRequestDurationSeconds(
  shots: ReadonlyArray<{ durationMs: number | null }>
): number {
  return (
    Math.round(
      shots.reduce(
        (sum, shot) => sum + (shot.durationMs ? shot.durationMs / 1000 : 10),
        0
      )
    ) || 30
  );
}

export async function musicTrackStaleness(input: {
  /** `inputHash` of the completed primary `sequence_music_variants` row. */
  storedInputHash: string | null;
  /** The sequence's live (selected) music prompt and tags. */
  prompt: string | null;
  tags: string | null;
  /** Pre-clamp request length — see {@link musicRequestDurationSeconds}. */
  requestDurationSeconds: number;
  /** The variant's audio model; `user-upload` and friends are untracked. */
  audioModel: string | null;
}): Promise<MusicTrackStaleness> {
  const { storedInputHash, prompt, tags, audioModel } = input;
  if (!storedInputHash || !prompt || !tags || !audioModel) return 'untracked';
  if (!isValidAudioModel(audioModel)) return 'untracked';

  const limits = getAudioModelDurationLimits(audioModel);
  const live = await computeSequenceMusicInputHash({
    prompt,
    tags,
    // The stamped duration is what `generateMusic` billed: the request
    // clamped to the model's ceiling, or the model's default with no request.
    durationSeconds: input.requestDurationSeconds
      ? Math.min(input.requestDurationSeconds, limits.max)
      : limits.default,
    audioModel,
  });
  return live === storedInputHash ? 'fresh' : 'stale';
}
