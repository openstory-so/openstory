import { DEFAULT_MUSIC_MODEL, type AudioModel } from './models';

/**
 * Resolve an audio models array from the dual-field pattern
 * (optional `audioModels[]` + optional legacy `musicModel`).
 *
 * Guarantees a non-empty, deduplicated result. Mirrors
 * {@link resolveImageModels} / {@link resolveVideoModels}. Audio is generated
 * per-sequence (one track per model in `sequence_music_variants`), so the
 * first element is the primary whose track also lands on the live
 * `sequences.music*` columns; the rest are alternates.
 */
export function resolveAudioModels(
  audioModels: AudioModel[] | undefined,
  musicModel: AudioModel | undefined
): AudioModel[] {
  const models =
    audioModels && audioModels.length > 0
      ? audioModels
      : musicModel
        ? [musicModel]
        : [DEFAULT_MUSIC_MODEL];
  return [...new Set(models)];
}
