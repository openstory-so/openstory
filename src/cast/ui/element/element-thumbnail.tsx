/**
 * The face of an element in a grid: a still, a clip's opening frame, or an
 * audio glyph (#1559).
 *
 * A clip shows a real frame rather than a generic film icon, which is the
 * difference between "some video" and "the one I meant". No poster is stored
 * for it: `preload="metadata"` fetches only the header, and nudging
 * `currentTime` off zero makes the browser decode and paint that first frame.
 * Zero bytes stored, nothing to keep in sync with the file, and it works the
 * same for a blob: URL mid-upload as for a stored one.
 *
 * The seek is what does the work — a `<video>` parked at 0 with no poster
 * renders blank in Chrome until something asks it for a frame.
 */

import { formatElementDuration } from '@/cast/element-kind';
import { AppImage } from '@/ui/shadcn/app-image';
import { cn } from '@/ui/utils';
import { AudioLines, ImagePlus } from 'lucide-react';

type ElementThumbnailProps = {
  kind: 'image' | 'video' | 'audio';
  /** Stored media URL, or a local object URL while the upload is in flight. */
  url: string | null;
  label: string;
  durationSeconds?: number | null;
  /** `contain` keeps a logo whole; `cover` fills a square tile. */
  fit?: 'contain' | 'cover';
  className?: string;
};

export const ElementThumbnail: React.FC<ElementThumbnailProps> = ({
  kind,
  url,
  label,
  durationSeconds = null,
  fit = 'contain',
  className,
}) => {
  const length = formatElementDuration(durationSeconds);

  if (kind === 'video' && url) {
    return (
      <div className={cn('relative h-full w-full', className)}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a silent poster frame, not playable media */}
        <video
          src={url}
          preload="metadata"
          muted
          playsInline
          // Never let it play or take focus: this is a thumbnail.
          tabIndex={-1}
          aria-label={label}
          className={cn(
            'h-full w-full pointer-events-none',
            fit === 'cover' ? 'object-cover' : 'object-contain'
          )}
          onLoadedMetadata={(event) => {
            // Some encodes have nothing at exactly 0; a hair past it is the
            // first frame everywhere, and is clamped for a clip shorter than
            // the offset.
            const el = event.currentTarget;
            el.currentTime = Math.min(0.1, (el.duration || 1) / 2);
          }}
        >
          <track kind="captions" />
        </video>
        {length && (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white tabular-nums">
            {length}
          </span>
        )}
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2',
          className
        )}
      >
        <AudioLines className="size-8 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">
          {`Audio${length ? ` · ${length}` : ''}`}
        </p>
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2',
          className
        )}
      >
        <ImagePlus className="size-8 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">No reference yet</p>
      </div>
    );
  }

  return (
    <AppImage
      src={url}
      alt={label}
      width={160}
      height={160}
      className={cn(
        'h-full w-full',
        fit === 'cover' ? 'object-cover' : 'object-contain',
        className
      )}
    />
  );
};
