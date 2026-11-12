/**
 * Get an image into a format the likeness check and the models can read,
 * before it is uploaded. AVIF and HEIC were stored, then refused by the check.
 */

/** Read as they are by the check and by every image model. */
const STORED_AS_IS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

/** Re-encoded to PNG when the browser can decode them. */
const CONVERTED = new Set(['avif', 'heic', 'heif', 'bmp', 'tif', 'tiff']);

function extensionOf(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

/** Whether `file` is an image this module re-encodes. */
export function needsImageConversion(file: File): boolean {
  const ext = extensionOf(file);
  if (STORED_AS_IS.has(ext)) return false;
  if (CONVERTED.has(ext)) return true;
  const subtype = /^image\/([a-z0-9.+-]+)/.exec(file.type.toLowerCase())?.[1];
  return subtype !== undefined && CONVERTED.has(subtype);
}

function unreadable(file: File): Error {
  const ext = extensionOf(file);
  return new Error(
    `This browser can’t read ${ext ? `a .${ext}` : 'this'} image. Convert it to JPEG or PNG and upload it again.`
  );
}

/** `file` unchanged, or its PNG copy. Throws when the browser cannot decode it. */
export async function normalizeImageFile(file: File): Promise<File> {
  if (!needsImageConversion(file)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw unreadable(file);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw unreadable(file);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (!blob) throw unreadable(file);
    const stem = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${stem}.png`, {
      type: 'image/png',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
