import {
  DEFAULT_IMAGE_MODEL,
  isValidTextToImageModel,
  safeTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';

/**
 * Image model for a character/location sheet generate or verify.
 *
 * An explicit pick (the Generate control) wins. Otherwise the live version's
 * `model` if it is a real generation id (`user-upload` / `prior` are skipped).
 * Otherwise the sequence default — so a sheet that has never been generated
 * still follows `sequences.imageModel`.
 */
export function resolveSheetImageModel(args: {
  explicit?: string | null;
  liveVersionModel?: string | null;
  sequenceImageModel: string | null;
}): TextToImageModel {
  if (args.explicit && isValidTextToImageModel(args.explicit)) {
    return args.explicit;
  }
  if (args.liveVersionModel && isValidTextToImageModel(args.liveVersionModel)) {
    return args.liveVersionModel;
  }
  return safeTextToImageModel(args.sequenceImageModel, DEFAULT_IMAGE_MODEL);
}
