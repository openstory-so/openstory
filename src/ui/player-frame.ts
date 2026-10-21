import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/models/aspect-ratios';
import { cn } from '@/ui/utils';

/**
 * The one frame every player sits in — the theatre's stitched canvas and the
 * shot's `<video>` alike: rounded, black, clipped to the aspect ratio. The
 * Video.js skin's own frame is turned off in `global.css` so this is the
 * only edge.
 */
export function playerFrameClassName(
  aspectRatio: AspectRatio,
  className?: string
): string {
  return cn(
    'relative w-full overflow-hidden rounded-lg bg-black',
    className,
    getAspectRatioClassName(aspectRatio)
  );
}
