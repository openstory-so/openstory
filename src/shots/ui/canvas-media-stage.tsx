/**
 * Centres media in the Scenes canvas and sizes it to the largest aspect-
 * correct rectangle that fits the available stage (#1074).
 *
 * Uses a size container (`cqw`/`cqh`) so 9:16 fills height without overflowing
 * the overflow-hidden sequence layout, and shot view uses the full stage
 * instead of a fixed 50vh cap.
 *
 * A bottom caption band is always reserved so the ScenePlayer "Fast preview"
 * note (positioned just under the frame) is never clipped when the media
 * fills the stage height.
 *
 * `below` sits under that band at its own height (capped, scrolling), and
 * the media band gives up the room — the frame shrinks, nothing overflows.
 */

import { getCanvasFitClassName } from '@/models/aspect-ratios';
import type { AspectRatio } from '@/models/aspect-ratios';
import { cn } from '@/ui/utils';
import type { ReactNode } from 'react';

/** Space under the fit frame for the preview caption line (text-xs + py-1). */
const CAPTION_BAND = 'h-6';

type CanvasMediaStageProps = {
  aspectRatio: AspectRatio;
  children: ReactNode;
  /** Shot ruler under the frame. Full stage width, so it can match the picture. */
  footer?: ReactNode;
  /** Content under the media — the shot's dialogue (#1657). */
  below?: ReactNode;
  className?: string;
};

export const CanvasMediaStage: React.FC<CanvasMediaStageProps> = ({
  aspectRatio,
  children,
  footer,
  below,
  className,
}) => (
  <div
    data-testid="canvas-media-stage"
    className={cn(
      'flex min-h-0 flex-1 flex-col px-4 pt-4 pb-4 md:px-8',
      className
    )}
  >
    {/* Size container is only the media band — caption band is a sibling so
        cqh never includes it, and full-height 9:16 still leaves room below. */}
    <div className="flex min-h-0 flex-1 items-center justify-center [container-type:size]">
      <div
        data-testid="canvas-media-frame"
        className={cn(
          'relative max-h-full max-w-full',
          getCanvasFitClassName(aspectRatio)
        )}
      >
        {children}
      </div>
    </div>
    {footer ? (
      <div data-testid="canvas-media-footer" className="w-full shrink-0 pt-2">
        {footer}
      </div>
    ) : null}
    <div
      data-testid="canvas-media-caption-band"
      className={cn('shrink-0', CAPTION_BAND)}
      aria-hidden
    />
    {below ? (
      <div
        data-testid="canvas-media-below"
        className="flex max-h-[40%] w-full max-w-2xl shrink-0 flex-col self-center overflow-y-auto"
      >
        {below}
      </div>
    ) : null}
  </div>
);
