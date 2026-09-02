import { z } from 'zod';

export type AspectRatio = '16:9' | '9:16' | '1:1';

export const aspectRatioSchema = z.enum(['16:9', '9:16', '1:1']);

type AspectRatioOption = {
  value: AspectRatio;
  label: string;
  width: number;
  height: number;
};

export const ASPECT_RATIOS: AspectRatioOption[] = [
  { value: '16:9', label: '16:9', width: 16, height: 9 },
  { value: '9:16', label: '9:16', width: 9, height: 16 },
  { value: '1:1', label: '1:1', width: 1, height: 1 },
];

export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';

export const getAspectRatioData = (ratio: AspectRatio) => {
  return ASPECT_RATIOS.find((r) => r.value === ratio);
};

/**
 * Image size presets for image generation providers (fal.ai preset names).
 */
export type ImageSize = 'square_hd' | 'portrait_16_9' | 'landscape_16_9';

export const DEFAULT_IMAGE_SIZE: ImageSize = 'landscape_16_9';
/**
 * Maps aspect ratios to image size presets for image generation.
 * Defaults to landscape_16_9 if aspect ratio is not recognized.
 */
export const aspectRatioToImageSize = (aspectRatio: AspectRatio): ImageSize => {
  const mapping: Record<AspectRatio, ImageSize> = {
    '16:9': 'landscape_16_9',
    '9:16': 'portrait_16_9',
    '1:1': 'square_hd',
  };
  return mapping[aspectRatio];
};

/**
 * Maps aspect ratios to image size presets for image generation.
 */
export const aspectRatioToDimensions = (
  aspectRatio: AspectRatio
): { width: number; height: number } => {
  const mapping: Record<AspectRatio, { width: number; height: number }> = {
    '16:9': { width: 1600, height: 900 },
    '9:16': { width: 900, height: 1600 },
    '1:1': { width: 1000, height: 1000 },
  };
  return mapping[aspectRatio];
};

/**
 * Maps aspect ratios to Tailwind CSS aspect ratio class names.
 * Used for displaying images and videos in the UI with correct proportions.
 */
export type VariantGridConfig = {
  cols: number;
  rows: number;
  count: number;
  imageSize: ImageSize;
};

const VARIANT_GRID_CONFIG: Record<AspectRatio, VariantGridConfig> = {
  '16:9': { cols: 3, rows: 3, count: 9, imageSize: 'landscape_16_9' },
  '9:16': { cols: 3, rows: 1, count: 3, imageSize: 'landscape_16_9' },
  '1:1': { cols: 3, rows: 3, count: 9, imageSize: 'square_hd' },
};

export const getVariantGridConfig = (
  aspectRatio: AspectRatio
): VariantGridConfig => {
  return VARIANT_GRID_CONFIG[aspectRatio];
};

export const getAspectRatioClassName = (aspectRatio: AspectRatio): string => {
  const mapping: Record<AspectRatio, string> = {
    '16:9': 'aspect-video', // aspect-video is 16:9
    '9:16': 'aspect-[9/16]', // portrait aspect ratio
    '1:1': 'aspect-square', // square aspect ratio
  };
  return mapping[aspectRatio];
};

/**
 * Width ÷ height for layout math (fit-in-box, canvas sizing).
 */
export const aspectRatioValue = (aspectRatio: AspectRatio): number => {
  const data = getAspectRatioData(aspectRatio);
  if (!data) return 16 / 9;
  return data.width / data.height;
};

/**
 * Largest box of `aspectRatio` that fits inside `boxWidth` × `boxHeight`.
 * Used by the Scenes canvas so 9:16 fills available height without overflowing,
 * and 16:9 fills width without exceeding the stage.
 */
export const fitAspectRatioInBox = (
  boxWidth: number,
  boxHeight: number,
  aspectRatio: AspectRatio
): { width: number; height: number } => {
  if (boxWidth <= 0 || boxHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const ar = aspectRatioValue(aspectRatio);
  let width = boxWidth;
  let height = width / ar;
  if (height > boxHeight) {
    height = boxHeight;
    width = height * ar;
  }
  return { width, height };
};

/**
 * Tailwind classes that size a frame to the largest aspect-correct rectangle
 * inside a `container-type: size` parent (uses cqw/cqh). Full class names so
 * Tailwind JIT always sees them.
 */
export const getCanvasFitClassName = (aspectRatio: AspectRatio): string => {
  const mapping: Record<AspectRatio, string> = {
    '16:9':
      'aspect-video w-[min(100cqw,calc(100cqh*16/9))] h-[min(100cqh,calc(100cqw*9/16))]',
    '9:16':
      'aspect-[9/16] w-[min(100cqw,calc(100cqh*9/16))] h-[min(100cqh,calc(100cqw*16/9))]',
    '1:1': 'aspect-square w-[min(100cqw,100cqh)] h-[min(100cqh,100cqw)]',
  };
  return mapping[aspectRatio];
};
