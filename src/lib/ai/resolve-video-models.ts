import {
  DEFAULT_VIDEO_MODEL,
  type ImageToVideoModel,
} from '@/shared/ai/models';

/**
 * Resolve a video models array from the dual-field pattern
 * (optional `videoModels[]` + optional legacy `videoModel`).
 *
 * Guarantees a non-empty, deduplicated result. Mirrors
 * {@link resolveImageModels} — the first element is treated as the primary
 * model (the one whose output also lands in the legacy `shots.video*`
 * columns); the rest are alternates stored only in `shot_variants`.
 */
export function resolveVideoModels(
  videoModels: ImageToVideoModel[] | undefined,
  videoModel: ImageToVideoModel | undefined
): ImageToVideoModel[] {
  const models =
    videoModels && videoModels.length > 0
      ? videoModels
      : videoModel
        ? [videoModel]
        : [DEFAULT_VIDEO_MODEL];
  return [...new Set(models)];
}
