import {
  type AspectRatio,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import { tileBackgroundCss } from '@/lib/image/tile-crop';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

type UpscaleOverlayProps = {
  aspectRatio: AspectRatio;
  /** Grid sheet URL for the CSS-cropped cell. */
  gridUrl?: string | null;
  /** 0-based cell index into that sheet. */
  variantIndex?: number | null;
  /** Cropped-tile URL from the generating version (refresh path). */
  cropUrl?: string | null;
  className?: string;
  /** List thumbs have no Frame variants button — show the chip there. */
  showLabel?: boolean;
};

/** True when either overlay source is present. */
export function hasUpscaleOverlay(options: {
  gridUrl?: string | null;
  variantIndex?: number | null;
  cropUrl?: string | null;
}): boolean {
  return (
    (options.variantIndex != null && Boolean(options.gridUrl)) ||
    Boolean(options.cropUrl)
  );
}

/**
 * In-flight variant upscale: CSS-crop the picked cell, else show the
 * persisted crop URL. The canvas uses the Frame variants button for status;
 * list thumbs pass `showLabel`.
 */
export function UpscaleOverlay({
  aspectRatio,
  gridUrl,
  variantIndex,
  cropUrl,
  className,
  showLabel = false,
}: UpscaleOverlayProps) {
  const grid = getVariantGridConfig(aspectRatio);
  const css =
    variantIndex != null
      ? tileBackgroundCss({
          index: variantIndex,
          gridCols: grid.cols,
          gridRows: grid.rows,
        })
      : null;
  const showCss = Boolean(gridUrl && css);

  if (!showCss && !cropUrl) return null;

  return (
    <div
      className={cn('absolute inset-0 overflow-hidden', className)}
      aria-live="polite"
      aria-label="Upscaling selected variant"
    >
      {showCss ? (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${gridUrl})`,
            backgroundRepeat: 'no-repeat',
            ...css,
          }}
        />
      ) : (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${cropUrl})` }}
        />
      )}
      {showLabel && (
        <span className="pointer-events-none absolute inset-x-0 bottom-1 z-10 flex justify-center">
          <span className="flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
            <Loader2 className="h-3 w-3 animate-spin" />
            Upscaling…
          </span>
        </span>
      )}
    </div>
  );
}
