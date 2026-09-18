/**
 * Live read behind {@link musicTrackStaleness}: the completed primary music
 * variant for the model that produced `sequences.musicUrl`, compared against
 * the sequence's current prompt / tags / shot durations (#1657).
 *
 * The model is not a lever here — a model switch writes its own primary row
 * per (sequence, model), so there is never a track stamped with a model the
 * sequence no longer selects.
 */

import {
  musicRequestDurationSeconds,
  musicTrackStaleness,
  type MusicTrackStaleness,
} from '@/audio/music-track-staleness';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence, Shot } from '@/platform/server/db/schema';

export async function readMusicTrackStaleness(
  scopedDb: Pick<ScopedDb, 'sequenceVariants'>,
  sequence: Pick<Sequence, 'id' | 'musicModel' | 'musicPrompt' | 'musicTags'>,
  shots: ReadonlyArray<Pick<Shot, 'durationMs'>>
): Promise<MusicTrackStaleness> {
  if (!sequence.musicModel) return 'untracked';
  const primary = await scopedDb.sequenceVariants.getMusicPrimary(
    sequence.id,
    sequence.musicModel
  );
  if (!primary || primary.status !== 'completed') return 'untracked';
  return await musicTrackStaleness({
    storedInputHash: primary.inputHash,
    prompt: sequence.musicPrompt,
    tags: sequence.musicTags,
    requestDurationSeconds: musicRequestDurationSeconds(shots),
    audioModel: primary.model,
  });
}
