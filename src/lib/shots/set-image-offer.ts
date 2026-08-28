/**
 * When the inspector should offer "Set Image" vs Generate.
 *
 * Set Image promotes the dropdown model's generated still onto the
 * selection pointer. It must not appear when the current still is already
 * that model — or when the current still is a user upload. Uploads store
 * `kind: 'upload'` / `model: 'user-upload'`, which is not a t2i id, so a
 * naive `safeTextToImageModel` comparison treated them as the app default
 * and offered Set Image (which would silently revert the upload to an
 * older generation).
 */

import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import { USER_UPLOAD_MODEL } from '@/lib/shots/upload-media';

export function isSetImageOffered(args: {
  variantCompleted: boolean;
  currentImageUrl: string | null | undefined;
  currentKind: string | null | undefined;
  currentModel: string | null | undefined;
  dropdownModel: string;
}): boolean {
  if (!args.variantCompleted || !args.currentImageUrl) return false;
  if (
    args.currentKind === 'upload' ||
    args.currentModel === USER_UPLOAD_MODEL
  ) {
    return false;
  }
  return (
    safeTextToImageModel(args.currentModel, DEFAULT_IMAGE_MODEL) !==
    args.dropdownModel
  );
}
