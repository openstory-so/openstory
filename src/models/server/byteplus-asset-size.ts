/**
 * CreateAsset rejects edges under 300px (`WidthTooSmall`). We do not
 * buffer or resize the still in the Worker — probe headers and refuse
 * (#1664). Location/element sheets never reach this path.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import { probeImageDimensions } from '@/stills/server/image-crop';

const MIN_PX = 300;

export function stillFitsArkCreateAsset(
  width: number,
  height: number
): boolean {
  return width >= MIN_PX && height >= MIN_PX;
}

/**
 * Header-only (≤64KB). Unreadable formats pass through — Ark still fails
 * loudly. Throws `NonRetryableError` so ingest does not burn a CreateAsset
 * turn on an image that cannot succeed.
 */
export async function assertArkCreateAssetSize(
  storedUrl: string
): Promise<void> {
  let dims: { width: number; height: number };
  try {
    dims = await probeImageDimensions(storedUrl);
  } catch {
    return;
  }
  if (stillFitsArkCreateAsset(dims.width, dims.height)) return;
  throw new NonRetryableError(
    `This image is smaller than 300px on an edge, which BytePlus rejects. Upload a still at least 300×300px. This one is ${dims.width}×${dims.height}px.`
  );
}
