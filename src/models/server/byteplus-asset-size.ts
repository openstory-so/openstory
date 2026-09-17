/**
 * CreateAsset rejects edges outside 300–6000px. Face-bearing stills stay
 * `asset://` (a public URL of a photoreal face 400s), so we upscale to the
 * 300px floor rather than skipping registration (#1664).
 */

import { readStorageObject, uploadFile } from '#storage';
import {
  STORAGE_BUCKETS,
  r2KeyFromUrl,
} from '@/platform/server/storage/buckets';
import { probeImageDimensions } from '@/stills/server/image-crop';
import { hashAssetIdentity } from './byteplus-assets';
import { toArkFetchableUrl } from './byteplus-asset-ingest';

const MIN_PX = 300;

/** Uniform scale so both edges are ≥300. Null when the still already fits. */
export function arkCreateAssetUpscaleSize(
  width: number,
  height: number
): { width: number; height: number } | null {
  if (width >= MIN_PX && height >= MIN_PX) return null;
  const scale = Math.max(MIN_PX / width, MIN_PX / height);
  return {
    width: Math.max(MIN_PX, Math.round(width * scale)),
    height: Math.max(MIN_PX, Math.round(height * scale)),
  };
}

async function readImageBytes(imageUrl: string): Promise<Uint8Array> {
  const key = r2KeyFromUrl(imageUrl);
  if (key !== null) {
    const object = await readStorageObject(key);
    if (!object) throw new Error(`Still not found in storage: ${key}`);
    return object.bytes;
  }
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch still ${imageUrl}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * URL CreateAsset should fetch. Pool identity stays `storedUrl`.
 * Unreadable headers pass through — Ark still fails loudly.
 */
export async function fitUrlForArkCreateAsset(
  storedUrl: string,
  publicUrl: string,
  falApiKey?: string
): Promise<string> {
  let dims: { width: number; height: number };
  try {
    dims = await probeImageDimensions(storedUrl);
  } catch {
    return publicUrl;
  }
  const size = arkCreateAssetUpscaleSize(dims.width, dims.height);
  if (!size) return publicUrl;

  const bytes = await readImageBytes(storedUrl);
  const { PhotonImage, SamplingFilter, resize } =
    await import('@cf-wasm/photon');
  const input = PhotonImage.new_from_byteslice(bytes);
  let scaled: ReturnType<typeof resize> | undefined;
  try {
    scaled = resize(input, size.width, size.height, SamplingFilter.CatmullRom);
    const png = scaled.get_bytes();
    const path = `ark-fit/${await hashAssetIdentity(storedUrl)}.png`;
    const uploaded = await uploadFile(STORAGE_BUCKETS.THUMBNAILS, path, png, {
      contentType: 'image/png',
    });
    return toArkFetchableUrl(uploaded.publicUrl, falApiKey);
  } finally {
    scaled?.free();
    input.free();
  }
}
