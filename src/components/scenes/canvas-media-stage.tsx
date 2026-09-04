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
 */

import { getCanvasFitClassName } from '@/shared/constants/aspect-ratios';
import type { AspectRatio } from '@/shared/constants/aspect-ratios';
import { cn } from '@/shared/utils';
import type { ReactNode } from 'react';

/** Space under the fit frame for the preview caption line (text-xs + py-1). */
const CAPTION_BAND = 'h-6';

type CanvasMediaStageProps = {
  aspectRatio: AspectRatio;
  children: ReactNode;
  className?: string;
};

export const CanvasMediaStage: React.FC<CanvasMediaStageProps> = ({
  aspectRatio,
  children,
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
    <div
      data-testid="canvas-media-caption-band"
      className={cn('shrink-0', CAPTION_BAND)}
      aria-hidden
    />
  </div>
);
