/**
 * Cut the close-up portrait out of a 4-panel talent sheet (panel 2 of 4,
 * square from the top of that column). Used as the talent avatar so we do
 * not spend another gpt_image_2 call after the sheet already exists.
 *
 * Landscape 4-panel (width/height ≥ 1.5) is cropped. Taller/square images
 * are copied as-is — they are already a portrait, not a grid.
 */

import { readStorageObject, uploadFile } from '#storage';
import {
  STORAGE_BUCKETS,
  type StorageBucket,
  type UploadResult,
} from '@/lib/storage/buckets';
import { requireStoredKey } from '@/lib/storage/copy-stored-image';

/** Generated talent sheets are 4 equal columns: front, close-up, side, rear. */
const TALENT_SHEET_COLS = 4;
/** 1-based column of the close-up portrait panel. */
const TALENT_SHEET_PORTRAIT_COL = 2;
const LANDSCAPE_SHEET_MIN_RATIO = 1.5;
const PORTRAIT_INSET = 0.05;

export type PortraitCropRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export function talentPortraitCropRect(
  gridWidth: number,
  gridHeight: number
): PortraitCropRect | 'copy' {
  if (gridWidth <= 0 || gridHeight <= 0) {
    throw new Error(`Invalid sheet dimensions: ${gridWidth}×${gridHeight}`);
  }
  if (gridWidth / gridHeight < LANDSCAPE_SHEET_MIN_RATIO) {
    return 'copy';
  }

  const tileWidth = Math.floor(gridWidth / TALENT_SHEET_COLS);
  const inset = Math.floor(tileWidth * PORTRAIT_INSET);
  const x1 = tileWidth * (TALENT_SHEET_PORTRAIT_COL - 1) + inset;
  const x2 = tileWidth * TALENT_SHEET_PORTRAIT_COL - inset;
  const side = x2 - x1;
  const y1 = inset;
  const y2 = y1 + side;
  if (side <= 0 || y2 > gridHeight) {
    throw new Error(
      `Degenerate portrait crop on ${gridWidth}×${gridHeight} sheet`
    );
  }
  return { x1, y1, x2, y2 };
}

export async function cropTalentSheetPortrait(params: {
  sheetUrl: string;
  destPath: string;
  destBucket?: StorageBucket;
}): Promise<UploadResult> {
  const destBucket = params.destBucket ?? STORAGE_BUCKETS.TALENT;
  const key = requireStoredKey(params.sheetUrl);
  const object = await readStorageObject(key);
  if (!object) {
    throw new Error(`Sheet image not found: ${params.sheetUrl}`);
  }

  const { PhotonImage, crop } = await import('@cf-wasm/photon');
  const input = PhotonImage.new_from_byteslice(object.bytes);
  try {
    const rect = talentPortraitCropRect(input.get_width(), input.get_height());
    if (rect === 'copy') {
      return uploadFile(destBucket, params.destPath, object.bytes, {
        contentType: object.contentType || 'image/png',
      });
    }
    const cropped = crop(input, rect.x1, rect.y1, rect.x2, rect.y2);
    try {
      return await uploadFile(
        destBucket,
        params.destPath,
        cropped.get_bytes(),
        {
          contentType: 'image/png',
        }
      );
    } finally {
      cropped.free();
    }
  } finally {
    input.free();
  }
}
