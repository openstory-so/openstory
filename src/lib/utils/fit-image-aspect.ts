/**
 * Center-crop a still to a sequence aspect ratio before upload.
 *
 * Motion models often take the start-frame's ratio as gospel (Grok Imagine
 * 1.5 has no aspect_ratio field; several fal i2v endpoints crop or reject
 * off-ratio stills). A 9:16 phone photo into a 16:9 sequence would otherwise
 * produce a mismatched clip — or fail. Cover-cropping into the sequence
 * frame is the same visual the canvas already shows via object-cover.
 */

import {
  getAspectRatioData,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';

/** Relative |actual - expected| / expected. 2% covers rounding on integer px. */
const ASPECT_RATIO_MATCH_EPSILON = 0.02;

export function aspectRatioNumber(ratio: AspectRatio): number {
  const data = getAspectRatioData(ratio);
  return data ? data.width / data.height : 16 / 9;
}

export function imageMatchesAspectRatio(
  width: number,
  height: number,
  ratio: AspectRatio,
  epsilon = ASPECT_RATIO_MATCH_EPSILON
): boolean {
  if (width <= 0 || height <= 0) return false;
  const expected = aspectRatioNumber(ratio);
  return Math.abs(width / height - expected) / expected <= epsilon;
}

/** Source rect for a cover crop (fill the target ratio, crop overflow). */
export function coverCropRect(
  width: number,
  height: number,
  targetRatio: number
): { sx: number; sy: number; sw: number; sh: number } {
  const actual = width / height;
  if (actual > targetRatio) {
    const sw = Math.max(1, Math.round(height * targetRatio));
    const sx = Math.max(0, Math.round((width - sw) / 2));
    return { sx, sy: 0, sw: Math.min(sw, width - sx), sh: height };
  }
  const sh = Math.max(1, Math.round(width / targetRatio));
  const sy = Math.max(0, Math.round((height - sh) / 2));
  return { sx: 0, sy, sw: width, sh: Math.min(sh, height - sy) };
}

export type FitImageToAspectResult = {
  file: File;
  cropped: boolean;
};

function outputMimeType(file: File): 'image/png' | 'image/jpeg' {
  const name = file.name.toLowerCase();
  if (file.type === 'image/png' || name.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      type,
      type === 'image/jpeg' ? 0.92 : undefined
    );
  });
}

/**
 * Center-crop `file` to `aspectRatio` when it does not already match.
 * Decode/canvas failures return the original file — a replace must not fail
 * because we could not inspect dimensions.
 */
export async function fitImageFileToAspectRatio(
  file: File,
  aspectRatio: AspectRatio
): Promise<FitImageToAspectResult> {
  if (typeof createImageBitmap !== 'function') {
    return { file, cropped: false };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { file, cropped: false };
  }
  try {
    if (imageMatchesAspectRatio(bitmap.width, bitmap.height, aspectRatio)) {
      return { file, cropped: false };
    }
    const crop = coverCropRect(
      bitmap.width,
      bitmap.height,
      aspectRatioNumber(aspectRatio)
    );
    const canvas = document.createElement('canvas');
    canvas.width = crop.sw;
    canvas.height = crop.sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { file, cropped: false };
    ctx.drawImage(
      bitmap,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      crop.sw,
      crop.sh
    );
    const type = outputMimeType(file);
    const blob = await canvasToBlob(canvas, type);
    if (!blob) return { file, cropped: false };
    return {
      file: new File([blob], file.name, { type: blob.type }),
      cropped: true,
    };
  } catch {
    return { file, cropped: false };
  } finally {
    bitmap.close();
  }
}
