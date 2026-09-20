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
  AUDIO_MODELS,
  clampAudioDuration,
  isValidAudioModel,
} from '@/models/models';
import { computeSequenceMusicInputHash } from '@/shots/input-hash';

export type MusicTrackStaleness = 'fresh' | 'stale' | 'untracked';

export async function musicTrackStaleness(input: {
  /** `inputHash` of the completed primary `sequence_music_variants` row. */
  storedInputHash: string | null;
  /** The sequence's live (selected) music prompt and tags. */
  prompt: string | null;
  tags: string | null;
  /** Pre-clamp request length — `musicRequestDurationSeconds`. */
  requestDurationSeconds: number;
  /** The variant's audio model; `user-upload` and friends are untracked. */
  audioModel: string | null;
}): Promise<MusicTrackStaleness> {
  const { storedInputHash, prompt, tags, audioModel } = input;
  if (!storedInputHash || !prompt || !tags || !audioModel) return 'untracked';
  if (!isValidAudioModel(audioModel)) return 'untracked';

  const live = await computeSequenceMusicInputHash({
    prompt,
    tags,
    // The stamped duration is what `generateMusic` billed.
    durationSeconds: clampAudioDuration(
      input.requestDurationSeconds,
      AUDIO_MODELS[audioModel]
    ),
    audioModel,
  });
  return live === storedInputHash ? 'fresh' : 'stale';
}
