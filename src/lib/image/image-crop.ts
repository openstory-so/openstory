/**
 * Variant-sheet tile crop.
 *
 * Production with a CDN domain: a `/cdn-cgi/image/trim=T;R;B;L/` URL.
 * Cloudflare crops at the edge when fal fetches it — zero Worker memory.
 *
 * Local / e2e-record / CDN-less deploys: no Image Resizing edge, so we crop
 * in-process with `@cf-wasm/photon` and upload the tile to R2. E2e replay
 * keeps the trim URL (aimock only string-matches and never fetches).
 */

import { getEnv } from '#env';
import { readStorageObject, uploadFile } from '#storage';
import { generateId } from '@/lib/db/id';
import {
  STORAGE_BUCKETS,
  isLocalStorageServing,
  r2KeyFromUrl,
  toCdnUrl,
} from '@/lib/storage/buckets';
import { tileCropRect } from './tile-crop';

type CropTileOptions = {
  gridImageUrl: string;
  row: number; // 1-based (1 = top row)
  col: number; // 1-based (1 = left column)
  gridCols?: number; // total columns in grid (default 3)
  gridRows?: number; // total rows in grid (default 3)
  teamId: string;
  sequenceId: string;
  shotId: string;
};

type CropTileResult = {
  url: string;
  /** R2 object key when we cropped in-process; empty for a trim URL. */
  path: string;
};

type ImageDimensions = { width: number; height: number };

/**
 * Bytes to read for format headers. PNG/WebP fit in <40B; JPEG SOF often
 * sits after EXIF/APP markers so we pull a larger prefix.
 */
const HEADER_BYTES = 64 * 1024;

/** Read one byte or null if out of range (avoids non-null assertions). */
function at(bytes: Uint8Array, i: number): number | null {
  const value = bytes.at(i);
  return value === undefined ? null : value;
}

/** Big-endian u16 from two known-in-range bytes. */
function be16(hi: number, lo: number): number {
  return (hi << 8) | lo;
}

/** Little-endian u16. */
function le16(lo: number, hi: number): number {
  return lo | (hi << 8);
}

/** Parse PNG IHDR (bytes 16–23). */
function parsePngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  // PNG magic: 89 50 4E 47
  if (at(bytes, 0) !== 0x89 || at(bytes, 1) !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

/**
 * Scan JPEG for the first SOF0/SOF1/SOF2 marker and read height/width.
 * Markers: FF C0 / FF C1 / FF C2 … (baseline / extended / progressive).
 */
function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4) return null;
  // JPEG SOI: FF D8
  if (at(bytes, 0) !== 0xff || at(bytes, 1) !== 0xd8) return null;

  let i = 2;
  while (i + 9 < bytes.length) {
    if (at(bytes, i) !== 0xff) {
      i += 1;
      continue;
    }
    // Skip fill bytes (FF FF …)
    while (i < bytes.length && at(bytes, i) === 0xff) i += 1;
    if (i >= bytes.length) break;

    const marker = at(bytes, i);
    if (marker === null) break;
    i += 1;

    // Standalone markers without a length field
    if (marker === 0xd9 /* EOI */ || marker === 0xda /* SOS */) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const lenHi = at(bytes, i);
    const lenLo = at(bytes, i + 1);
    if (lenHi === null || lenLo === null) break;
    const segmentLength = be16(lenHi, lenLo);
    if (segmentLength < 2) break;

    // SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15 carry dimensions
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      // segment: len(2) precision(1) height(2) width(2)
      const hHi = at(bytes, i + 3);
      const hLo = at(bytes, i + 4);
      const wHi = at(bytes, i + 5);
      const wLo = at(bytes, i + 6);
      if (hHi === null || hLo === null || wHi === null || wLo === null) {
        return null;
      }
      const height = be16(hHi, hLo);
      const width = be16(wHi, wLo);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }

    i += segmentLength;
  }
  return null;
}

/** Parse WebP VP8X / VP8 / VP8L headers. */
function parseWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  // RIFF....WEBP
  if (
    at(bytes, 0) !== 0x52 ||
    at(bytes, 1) !== 0x49 ||
    at(bytes, 2) !== 0x46 ||
    at(bytes, 3) !== 0x46
  ) {
    return null;
  }
  if (
    at(bytes, 8) !== 0x57 ||
    at(bytes, 9) !== 0x45 ||
    at(bytes, 10) !== 0x42 ||
    at(bytes, 11) !== 0x50
  ) {
    return null;
  }

  const c0 = at(bytes, 12);
  const c1 = at(bytes, 13);
  const c2 = at(bytes, 14);
  const c3 = at(bytes, 15);
  if (c0 === null || c1 === null || c2 === null || c3 === null) return null;
  const fourCC = String.fromCharCode(c0, c1, c2, c3);

  if (fourCC === 'VP8X') {
    // Canvas width/height are 24-bit little-endian, stored as size-1
    const w0 = at(bytes, 24);
    const w1 = at(bytes, 25);
    const w2 = at(bytes, 26);
    const h0 = at(bytes, 27);
    const h1 = at(bytes, 28);
    const h2 = at(bytes, 29);
    if (
      w0 === null ||
      w1 === null ||
      w2 === null ||
      h0 === null ||
      h1 === null ||
      h2 === null
    ) {
      return null;
    }
    const width = 1 + (w0 | (w1 << 8) | (w2 << 16));
    const height = 1 + (h0 | (h1 << 8) | (h2 << 16));
    return { width, height };
  }

  if (fourCC === 'VP8 ') {
    // Lossy: frame tag (3) + start code 9d 01 2a, then 16-bit LE width/height
    // with 2 high bits as scale. Chunk data starts at offset 20.
    const dataStart = 20;
    if (
      at(bytes, dataStart + 3) === 0x9d &&
      at(bytes, dataStart + 4) === 0x01 &&
      at(bytes, dataStart + 5) === 0x2a
    ) {
      const wLo = at(bytes, dataStart + 6);
      const wHi = at(bytes, dataStart + 7);
      const hLo = at(bytes, dataStart + 8);
      const hHi = at(bytes, dataStart + 9);
      if (wLo === null || wHi === null || hLo === null || hHi === null) {
        return null;
      }
      return {
        width: le16(wLo, wHi) & 0x3fff,
        height: le16(hLo, hHi) & 0x3fff,
      };
    }
  }

  if (fourCC === 'VP8L') {
    // Lossless signature 0x2f, then 14-bit width-1 / height-1 packed
    if (at(bytes, 20) !== 0x2f) return null;
    const b0 = at(bytes, 21);
    const b1 = at(bytes, 22);
    const b2 = at(bytes, 23);
    const b3 = at(bytes, 24);
    if (b0 === null || b1 === null || b2 === null || b3 === null) return null;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }

  return null;
}

/**
 * Read width/height from PNG, JPEG, or WebP headers. Stored `/r2/` URLs
 * read a prefix from the R2 binding; external URLs use a Range request —
 * no full download.
 */
export function parseImageDimensions(
  bytes: Uint8Array
): ImageDimensions | null {
  return (
    parsePngDimensions(bytes) ??
    parseJpegDimensions(bytes) ??
    parseWebpDimensions(bytes)
  );
}

async function getImageDimensions(imageUrl: string): Promise<ImageDimensions> {
  const key = r2KeyFromUrl(imageUrl);
  let bytes: Uint8Array;
  if (key !== null) {
    const object = await readStorageObject(key, {
      offset: 0,
      length: HEADER_BYTES,
    });
    if (!object) {
      throw new Error(`Grid image not found in storage: ${key}`);
    }
    bytes = object.bytes;
  } else {
    const response = await fetch(imageUrl, {
      headers: { Range: `bytes=0-${HEADER_BYTES - 1}` },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch grid image header ${imageUrl}: ${response.status}`
      );
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  const dims = parseImageDimensions(bytes);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    throw new Error(
      'Could not read image dimensions — supported formats: PNG, JPEG, WebP'
    );
  }
  return dims;
}

function isE2eReplay(): boolean {
  const env = getEnv();
  if (env.E2E_TEST !== 'true') return false;
  const record = (env as Record<string, string | undefined>).E2E_RECORD;
  return record !== '1';
}

/** True when fal cannot fetch a `/cdn-cgi/image/trim=` URL. */
function shouldCropInProcess(): boolean {
  return isLocalStorageServing() && !isE2eReplay();
}

async function readGridBytes(imageUrl: string): Promise<Uint8Array> {
  const key = r2KeyFromUrl(imageUrl);
  if (key !== null) {
    const object = await readStorageObject(key);
    if (!object) {
      throw new Error(`Grid image not found in storage: ${key}`);
    }
    return object.bytes;
  }
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch grid image ${imageUrl}: ${response.status}`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function cropTileInProcess(options: {
  gridImageUrl: string;
  row: number;
  col: number;
  gridCols: number;
  gridRows: number;
  teamId: string;
  sequenceId: string;
  shotId: string;
}): Promise<CropTileResult> {
  const {
    gridImageUrl,
    row,
    col,
    gridCols,
    gridRows,
    teamId,
    sequenceId,
    shotId,
  } = options;
  const bytes = await readGridBytes(gridImageUrl);
  const { PhotonImage, crop } = await import('@cf-wasm/photon');
  const input = PhotonImage.new_from_byteslice(bytes);
  try {
    const rect = tileCropRect({
      gridWidth: input.get_width(),
      gridHeight: input.get_height(),
      row,
      col,
      gridCols,
      gridRows,
    });
    const cropped = crop(input, rect.x1, rect.y1, rect.x2, rect.y2);
    try {
      const png = cropped.get_bytes();
      const path = `teams/${teamId}/sequences/${sequenceId}/frames/${shotId}/variant-tile-${generateId()}.png`;
      const uploaded = await uploadFile(STORAGE_BUCKETS.THUMBNAILS, path, png, {
        contentType: 'image/png',
      });
      return { url: uploaded.publicUrl, path: uploaded.path };
    } finally {
      cropped.free();
    }
  } finally {
    input.free();
  }
}

function trimUrlFor(gridImageUrl: string, trim: string): string {
  const cdnUrl = toCdnUrl(gridImageUrl);
  if (cdnUrl) {
    const parsed = new URL(cdnUrl);
    return `${parsed.origin}/cdn-cgi/image/trim=${trim}${parsed.pathname}`;
  }
  if (gridImageUrl.startsWith('/')) {
    return `/cdn-cgi/image/trim=${trim}${gridImageUrl}`;
  }
  const parsed = new URL(gridImageUrl);
  return `${parsed.origin}/cdn-cgi/image/trim=${trim}${parsed.pathname}`;
}

/**
 * Crop one cell out of a variant grid sheet.
 *
 * With a CDN domain: a trim URL (Cloudflare crops when fal fetches it).
 * Locally (and on CDN-less deploys, and e2e record): photon crop + R2 upload
 * so the returned URL is actually fetchable.
 */
export async function cropTileFromGrid(
  options: CropTileOptions
): Promise<CropTileResult> {
  const {
    gridImageUrl,
    row,
    col,
    gridCols = 3,
    gridRows = 3,
    teamId,
    sequenceId,
    shotId,
  } = options;

  if (shouldCropInProcess()) {
    return cropTileInProcess({
      gridImageUrl,
      row,
      col,
      gridCols,
      gridRows,
      teamId,
      sequenceId,
      shotId,
    });
  }

  const { width: gridWidth, height: gridHeight } =
    await getImageDimensions(gridImageUrl);
  const { trim } = tileCropRect({
    gridWidth,
    gridHeight,
    row,
    col,
    gridCols,
    gridRows,
  });
  return { url: trimUrlFor(gridImageUrl, trim), path: '' };
}
