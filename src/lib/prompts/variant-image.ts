import type { ImageSize } from '@/lib/constants/aspect-ratios';

type GridLayout = {
  cols: number;
  rows: number;
};

/**
 * Get the grid layout description based on shape
 */
function getLayoutDescription(
  imageSize: ImageSize,
  grid: GridLayout,
  count: number
): string {
  if (grid.rows === 1) {
    return `${count} equal side-by-side portrait panels in a 16:9 landscape image. Each column is exactly 1/${grid.cols} of the width and the full height. Separate panels with a thin black gutter.`;
  }
  const ratio = imageSize === 'square_hd' ? '1:1 square' : '16:9 landscape';
  return `a rigid ${grid.cols}x${grid.rows} grid of ${count} equal rectangular cells in a ${ratio} image. Each cell is exactly 1/${grid.cols} of the width and 1/${grid.rows} of the height. Separate cells with a thin black gutter.`;
}

/**
 * Generate variant image prompt with aspect ratio context and optional scene description
 */
export function getVariantImagePrompt(
  imageSize: ImageSize,
  scenePrompt?: string,
  grid: GridLayout = { cols: 3, rows: 3 }
): string {
  const count = grid.cols * grid.rows;
  const layout = getLayoutDescription(imageSize, grid, count);

  const sceneContext = scenePrompt ? `\nScene: ${scenePrompt}\n` : '';

  return `${count}-panel cinematic storyboard CONTACT SHEET derived from Image 1. Mix Wide, Medium, and Tight shots of the same scene.

Layout: ${layout}
- Content must not cross, bleed, or overlap a gutter. No collage.
- Each cell is a complete, independently framed shot — not a crop of a larger scene.
${sceneContext}
Every panel is a shot of the same scene as Image 1 — keep the characters, wardrobe, lighting, color grade, and texture consistent across all panels.

No text, dialogue bubbles, scene numbers, or watermarks.
`;
}
