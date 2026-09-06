import { DEFAULT_IMAGE_MODEL, type TextToImageModel } from '@/shared/ai/models';

/**
 * Resolve an image models array from the dual-field pattern
 * (optional `imageModels[]` + optional legacy `imageModel`).
 *
 * Guarantees a non-empty, deduplicated result.
 */
export function resolveImageModels(
  imageModels: TextToImageModel[] | undefined,
  imageModel: TextToImageModel | undefined
): TextToImageModel[] {
  const models =
    imageModels && imageModels.length > 0
      ? imageModels
      : imageModel
        ? [imageModel]
        : [DEFAULT_IMAGE_MODEL];
  return [...new Set(models)];
}
