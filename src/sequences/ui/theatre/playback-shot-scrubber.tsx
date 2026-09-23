import { videoPosterSrc } from '@/shots/packed-clip-window';
import { AppImage } from '@/ui/shadcn/app-image';
import { cn } from '@/ui/utils';

import type { PlaybackShotSpan } from './playback-shot-spans';

type PlaybackShotScrubberProps = {
  spans: readonly PlaybackShotSpan[];
  currentShotId?: string;
  currentTime: number;
  onSeek: (seconds: number) => void;
};

/**
 * Shot thumbnails sized to the sequence clock. Clicking one seeks the
 * sequence player to that shot (#1771). The time scrubber on the video
 * stays the fine control; this is the shot ruler under it.
 */
export const PlaybackShotScrubber: React.FC<PlaybackShotScrubberProps> = ({
  spans,
  currentShotId,
  currentTime,
  onSeek,
}) => {
  const total = spans[spans.length - 1]?.endSeconds ?? 0;
  const currentIndex = spans.findIndex((span) => span.shotId === currentShotId);
  const current = currentIndex >= 0 ? spans[currentIndex] : undefined;
  const label = current
    ? `Shot ${current.shotNumber ?? currentIndex + 1} of ${spans.length}`
    : `${spans.length} shots`;
  const playhead =
    total > 0 ? Math.min(100, Math.max(0, (currentTime / total) * 100)) : 0;

  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="playback-shot-scrubber"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="relative flex h-12 w-full overflow-hidden rounded-md bg-muted">
        {spans.map((span, index) => {
          const width =
            total > 0
              ? ((span.endSeconds - span.startSeconds) / total) * 100
              : 0;
          const active = span.shotId === currentShotId;
          const shotLabel = `Shot ${span.shotNumber ?? index + 1}`;
          return (
            <button
              key={span.shotId}
              type="button"
              data-shot-id={span.shotId}
              data-current={active ? 'true' : undefined}
              aria-label={shotLabel}
              aria-current={active ? 'true' : undefined}
              title={shotLabel}
              style={{ width: `${width}%` }}
              className={cn(
                'relative h-full min-w-0 overflow-hidden',
                active && 'z-10 ring-2 ring-primary ring-inset'
              )}
              onClick={() => onSeek(span.startSeconds)}
            >
              {span.thumbnailUrl ? (
                <AppImage
                  src={span.thumbnailUrl}
                  alt=""
                  width={160}
                  height={90}
                  className="h-full w-full object-cover"
                />
              ) : span.videoPosterUrl ? (
                <video
                  src={videoPosterSrc(
                    span.videoPosterUrl,
                    span.videoPosterSeconds
                  )}
                  muted
                  playsInline
                  preload="metadata"
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
                  {span.shotNumber ?? index + 1}
                </span>
              )}
            </button>
          );
        })}
        {total > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-foreground"
            style={{ left: `${playhead}%` }}
          />
        ) : null}
      </div>
    </div>
  );
};
