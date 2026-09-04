/**
 * Poster a player may show before the clip paints its own first frame.
 *
 * A still is the opening frame only when this shot uses a start frame.
 * The sequence poster and storyboard preview are a different picture —
 * never the cut.
 */
export function playerPosterSrc(input: {
  videoUrl?: string | null;
  stillUrl?: string | null;
  previewUrl?: string | null;
  overrideImageUrl?: string | null;
  usesStartFrame: boolean;
}): string | null {
  if (input.overrideImageUrl) return input.overrideImageUrl;
  if (input.usesStartFrame && input.stillUrl) return input.stillUrl;
  if (input.videoUrl) return null;
  return input.previewUrl ?? null;
}
