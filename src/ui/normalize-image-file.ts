/** Re-encode an image the likeness check cannot read to PNG, before upload. */

import { rasterizeToPng } from '@/ui/clipboard';

/** Re-encoded when the browser can decode them. */
const CONVERTED = new Set(['avif', 'heic', 'heif', 'bmp', 'tif', 'tiff']);

/** Whether `file` is an image this module re-encodes. */
export function needsImageConversion(file: File): boolean {
  const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  return CONVERTED.has(ext) || CONVERTED.has(file.type.replace('image/', ''));
}

/** `file` unchanged, or its PNG copy. Throws when the browser cannot convert it. */
export async function normalizeImageFile(file: File): Promise<File> {
  if (!needsImageConversion(file)) return file;
  const png = await rasterizeToPng(file).catch((cause: unknown) => {
    throw new Error(
      `This browser can’t convert ${file.name}. Save it as a JPEG or PNG and upload it again.`,
      { cause }
    );
  });
  return new File([png], `${file.name.replace(/\.[^.]+$/, '')}.png`, {
    type: 'image/png',
    lastModified: file.lastModified,
  });
}
