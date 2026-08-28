import { AppImage } from '@/components/ui/app-image';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import {
  captureVideoPlay,
  captureVideoPlayFailed,
  captureVideoWatched,
  createPlaybackTracker,
  type PlaybackTracker,
  type VideoPlaySource,
} from '@/lib/observability/player-events';
import { cn } from '@/lib/utils';
import { usePostHog } from '@posthog/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

// Dynamic, and rendered only after mount — see video-player-surface.tsx. The
// import must not be evaluated on the server: `@videojs/store` constructs an
// AbortController at module scope, which Workerd rejects with "Disallowed
// operation called within global scope" (#1139). `lazy()` alone is not enough,
// because React invokes the loader during SSR too; the `mounted` gate below is
// what actually keeps the server out of it.
const VideoPlayerSurface = lazy(() => import('./video-player-surface'));

type VideoPlayerProps = {
  src: string;
  chaptersUrl?: string;
  posterSrc?: string | null;
  aspectRatio: AspectRatio;
  className?: string;
  autoPlay?: boolean;
  onLoadedMetadata?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPause?: () => void;
  onEnded?: () => void;
  onPlay?: () => void;
  /** PostHog `video_play` / `video_play_failed` source. Omit to skip capture. */
  playSource?: VideoPlaySource;
  sequenceId?: string;
  shotId?: string;
};

/**
 * True once the component has mounted in the browser. `useEffect` never runs
 * during SSR, so this stays false on the server and through the hydration pass
 * — which is the point: it keeps the Video.js chunk out of the server's
 * evaluated module graph, and keeps the hydrated tree identical to the
 * server-rendered one.
 */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Poster (or skeleton) sized to the player's box. Doubles as the SSR output and
 * the lazy-load fallback, so the player swapping in cannot shift layout.
 */
const PlayerPlaceholder: React.FC<{
  posterSrc?: string | null;
  alt: string;
}> = ({ posterSrc, alt }) =>
  posterSrc ? (
    <AppImage
      // key forces a fresh image when the still changes so the browser never
      // keeps the previous shot's decoded bitmap after a switch.
      key={posterSrc}
      src={posterSrc}
      alt={alt}
      width={1280}
      height={720}
      className="absolute inset-0 h-full w-full object-cover"
    />
  ) : (
    <Skeleton className="absolute inset-0 h-full w-full" />
  );

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  chaptersUrl,
  posterSrc,
  aspectRatio,
  className,
  autoPlay = false,
  onLoadedMetadata,
  onTimeUpdate,
  onPause,
  onEnded,
  onPlay,
  playSource,
  sequenceId,
  shotId,
}) => {
  const mounted = useMounted();
  const posthog = usePostHog();

  // video_play / video_watched / stalled-play analytics (#1301). Only when a
  // `playSource` is given; autoplay counts as its own source. Props via a
  // ref so the one tracker instance reports the current shot.
  const eventProps = playSource
    ? {
        source: autoPlay ? ('autoplay' as const) : playSource,
        sequence_id: sequenceId,
        shot_id: shotId,
      }
    : null;
  const eventPropsRef = useRef(eventProps);
  eventPropsRef.current = eventProps;
  const trackerRef = useRef<PlaybackTracker | null>(null);
  trackerRef.current ??= createPlaybackTracker({
    onStall: () => {
      if (eventPropsRef.current) {
        captureVideoPlayFailed(posthog, {
          ...eventPropsRef.current,
          reason: 'timeout',
        });
      }
    },
  });
  const tracker = trackerRef.current;
  const flushWatched = (completed?: boolean) => {
    const watched = tracker.stop(completed);
    if (!watched || !eventPropsRef.current) return;
    if (watched.seconds_watched === 0 && !watched.completed) return;
    captureVideoWatched(posthog, { ...eventPropsRef.current, ...watched });
  };
  // Leaving mid-play (shot switch remounts the player) still counts as watched.
  useEffect(() => () => flushWatched(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show skeleton when there's no video source and no poster
  if (!src && !posterSrc) {
    return (
      <Skeleton
        className={cn(
          'w-full',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      />
    );
  }

  // Image-only mode: VideoSkin collapses to 0px without a video src, so render
  // the poster directly into a properly-sized aspect-ratio container instead.
  if (!src && posterSrc) {
    return (
      <div
        className={cn(
          'relative w-full overflow-hidden',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      >
        <PlayerPlaceholder posterSrc={posterSrc} alt="Scene thumbnail" />
      </div>
    );
  }

  const placeholder = (
    <PlayerPlaceholder posterSrc={posterSrc} alt="Video thumbnail" />
  );

  return (
    <div
      className={cn(
        'relative w-full',
        className,
        getAspectRatioClassName(aspectRatio)
      )}
    >
      {mounted ? (
        <Suspense fallback={placeholder}>
          <VideoPlayerSurface
            src={src}
            chaptersUrl={chaptersUrl}
            posterSrc={posterSrc}
            autoPlay={autoPlay}
            onLoadedMetadata={(duration) => {
              tracker.setDuration(duration);
              onLoadedMetadata?.(duration);
            }}
            onTimeUpdate={(t) => {
              tracker.tick(t);
              onTimeUpdate?.(t);
            }}
            onPause={() => {
              // `pause` also fires right before `ended`; the tracker infers
              // completion from position so that pair reports once.
              flushWatched();
              onPause?.();
            }}
            onEnded={() => {
              flushWatched(true);
              onEnded?.();
            }}
            onPlay={() => {
              onPlay?.();
              if (eventProps) {
                tracker.start();
                captureVideoPlay(posthog, eventProps);
              }
            }}
            onError={(reason) => {
              tracker.dispose();
              if (eventProps) {
                captureVideoPlayFailed(posthog, { ...eventProps, reason });
              }
            }}
          />
        </Suspense>
      ) : (
        placeholder
      )}
    </div>
  );
};
