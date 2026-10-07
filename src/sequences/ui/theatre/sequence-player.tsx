/**
 * Theatre player. Stitches clip videos + music via Mediabunny on a canvas,
 * under the Video.js 10 skin (#1258). Clips load as the playhead reaches them
 * (#1845); a progress bar covers the opening, the skin's spinner any stall.
 *
 * Falls back to an overlay message when the browser can't decode the source
 * codecs. Download/Copy live on `overlayActions` (theatre).
 */

import { Button } from '@/ui/shadcn/button';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/models/aspect-ratios';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import {
  playbackClipsKey,
  type PlaybackClip,
  type SequencePlayerMeta,
} from '@openstory/stitch-player';
import { getLogger } from '@/platform/logger';
import {
  captureVideoPlay,
  captureVideoPlayFailed,
  captureVideoWatched,
  createPlaybackTracker,
  type PlaybackTracker,
  type VideoPlaySource,
} from './player-events';
import { cn } from '@/ui/utils';
import { usePostHog } from '@posthog/react';
import { AlertCircle, Music, TriangleAlert } from 'lucide-react';
import { StitchedPlayer } from '@openstory/stitch-player/react';
import { useEffect, useRef, useState } from 'react';

const logger = getLogger(['openstory', 'sequence-player']);

type SequencePlayerProps = {
  clips: PlaybackClip[];
  musicUrl: string | null;
  /** Gain in dB on the music only (a measured loudness normalization); `null` is 0 dB. */
  musicGainDb: number | null;
  /**
   * Whether the music track plays. Pushed into the engine's music-only gain
   * node so toggling is live and never re-prepares the player (#834). When
   * `musicUrl` is null this is moot — no music toggle is shown.
   */
  musicEnabled: boolean;
  /** Persist the music on/off choice (see SceneCanvas → useSetSequenceMusic). */
  onMusicEnabledChange: (enabled: boolean) => void;
  aspectRatio: AspectRatio;
  className?: string;
  /** Slot rendered as an overlay (top-right) — e.g. the Download / Share actions. */
  overlayActions?: React.ReactNode;
  /** PostHog `video_play` source. Theatre player on the scenes canvas. */
  playSource?: VideoPlaySource;
  sequenceId?: string;
  /**
   * One-shot: start playback once the player is ready. The scene-list play
   * button sets this; consume it via `onAutoPlayConsumed` so a later rebuild
   * does not auto-resume (#1526).
   */
  autoPlay?: boolean;
  onAutoPlayConsumed?: () => void;
  /** Playhead plus the measured clip starts, once known (#1771). */
  onTimeUpdate?: (time: number, clipOffsetsSeconds?: readonly number[]) => void;
  /** Draft clips in this cut (#1756): "Draft cut · 2 days left", "3 of 12 shots are drafts". */
  draftLabel?: string | null;
};

export const SequencePlayer: React.FC<SequencePlayerProps> = ({
  clips,
  musicUrl,
  musicGainDb,
  musicEnabled,
  onMusicEnabledChange,
  aspectRatio,
  className,
  overlayActions,
  playSource = 'theatre',
  sequenceId,
  autoPlay = false,
  onAutoPlayConsumed,
  onTimeUpdate,
  draftLabel = null,
}) => {
  const posthog = usePostHog();
  const clipsKey = playbackClipsKey(clips);
  // Shots that still have no video (#1690) play as stills on the canvas.
  const hasStills = clips.some((clip) => !('videoUrl' in clip));

  const [meta, setMeta] = useState<SequencePlayerMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedClips, setLoadedClips] = useState(0);
  const eventPropsRef = useRef({ source: playSource, sequence_id: sequenceId });
  eventPropsRef.current = { source: playSource, sequence_id: sequenceId };
  const trackerRef = useRef<PlaybackTracker | null>(null);
  trackerRef.current ??= createPlaybackTracker({
    onStall: () =>
      captureVideoPlayFailed(posthog, {
        ...eventPropsRef.current,
        reason: 'timeout',
      }),
  });
  const tracker = trackerRef.current;
  const flushWatched = (completed?: boolean) => {
    const watched = tracker.stop(completed);
    if (!watched || (watched.seconds_watched === 0 && !watched.completed)) {
      return;
    }
    captureVideoWatched(posthog, { ...eventPropsRef.current, ...watched });
  };

  useEffect(() => () => flushWatched(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop stitch state when the clip list changes, so a stale mixed-res
  // warning / loading label cannot leak. Flush watched here (not only on
  // SequencePlayer unmount): the stitcher is torn down while this shell stays
  // mounted, and detach does not emit `pause`.
  useEffect(() => {
    setMeta(null);
    setLoadedClips(0);
    setError(null);
    flushWatched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clipsKey, not clips identity (#1284)
  }, [clipsKey, musicUrl, musicGainDb]);

  const frameClassName = cn(
    'relative w-full overflow-hidden rounded-lg bg-black',
    className,
    getAspectRatioClassName(aspectRatio)
  );

  const overlay = (
    <>
      <div className="pointer-events-none absolute top-2 left-2 z-10 flex flex-col items-start gap-1">
        {draftLabel && (
          <span
            data-testid="theatre-draft-label"
            className="rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm"
          >
            {draftLabel}
          </span>
        )}
      </div>
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
        {meta?.hasMixedResolutions && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="mixed-resolution-warning"
                className="flex h-8 w-8 items-center justify-center rounded-md bg-black/50 text-amber-400"
                aria-label="Mixed resolutions warning"
              >
                <TriangleAlert className="h-4 w-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Clips use different resolutions ({meta.resolutionsLabel}) because
              they were generated by different models.{' '}
              {meta.hasMixedAspectRatios
                ? 'Playback letterboxes them into a common frame'
                : 'Smaller clips are upscaled to match'}
              ; the export will be normalized (re-encoded), which is slower.
            </TooltipContent>
          </Tooltip>
        )}
        {musicUrl && (
          <MusicToggle
            enabled={musicEnabled}
            onToggle={() => onMusicEnabledChange(!musicEnabled)}
            className="bg-black/50 hover:bg-black/70"
          />
        )}
        {overlayActions}
      </div>
    </>
  );

  // The cut opens on its first shot's still — a clip's opening frame, or the
  // still of a shot with no video yet — while the stitcher warms up, not a
  // grey box.
  const opening = clips[0];
  const openingUrl =
    opening && 'videoUrl' in opening ? opening.posterUrl : opening?.imageUrl;
  const firstFrame = openingUrl ? (
    <img
      data-testid="player-loading"
      src={openingUrl}
      alt=""
      className="pointer-events-none absolute inset-0 z-10 h-full w-full bg-black object-contain"
    />
  ) : (
    <Skeleton
      data-testid="player-loading"
      className="absolute inset-0 z-10 h-full w-full bg-muted/40"
    />
  );

  const stitchError =
    error ?? (clips.length === 0 ? 'No clips ready to play yet.' : null);

  if (stitchError) {
    return (
      <div
        data-testid="player-error"
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border bg-muted/20 p-8',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      >
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground text-center">
          {stitchError}
        </p>
        <p className="text-xs text-muted-foreground text-center max-w-sm">
          {hasStills
            ? 'Check your connection and retry playback.'
            : 'Download → Render MP4 on server gives a file any browser plays.'}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setMeta(null);
            setLoadedClips(0);
            setError(null);
          }}
        >
          Retry playback
        </Button>
      </div>
    );
  }

  // Opening reads every clip's header (durations, sizes); then the first
  // frame decodes. Clip bytes load later, as the playhead reaches them.
  const opened = Math.min(loadedClips, clips.length);
  const loading = (
    <>
      {firstFrame}
      <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-4 pt-8 pb-3">
        <p aria-live="polite" className="text-xs text-white/80 tabular-nums">
          {opened < clips.length
            ? `Loading clip ${opened + 1} of ${clips.length}…`
            : 'Preparing playback…'}
        </p>
        <progress
          aria-label="Loading sequence"
          max={clips.length}
          value={opened}
          className="h-1 w-full max-w-xs appearance-none overflow-hidden rounded-full bg-white/20 [&::-moz-progress-bar]:bg-white/80 [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-white/80 [&::-webkit-progress-value]:transition-[width] motion-reduce:[&::-webkit-progress-value]:transition-none"
        />
      </div>
    </>
  );

  return (
    <div
      data-testid="sequence-player"
      data-state={meta ? 'ready' : 'loading'}
      className={frameClassName}
    >
      <div className="absolute inset-0 h-full w-full">
        <StitchedPlayer
          clips={clips}
          musicUrl={musicUrl}
          musicGainDb={musicGainDb}
          musicEnabled={musicEnabled}
          autoPlay={autoPlay}
          className="h-full w-full"
          logger={logger}
          onLoadProgress={(loaded) => setLoadedClips(loaded)}
          onMeta={(next) => {
            setMeta(next);
            tracker.setDuration(next.durationSeconds);
          }}
          onTimeUpdate={(t) => {
            tracker.tick(t);
            onTimeUpdate?.(t, meta?.clipOffsetsSeconds);
          }}
          onPlay={() => {
            if (!tracker.isActive()) tracker.start();
            captureVideoPlay(posthog, {
              source: playSource,
              sequence_id: sequenceId,
            });
            onAutoPlayConsumed?.();
          }}
          onPause={() => flushWatched()}
          onEnded={() => flushWatched(true)}
          onError={(reason) => {
            tracker.dispose();
            setError(reason);
            captureVideoPlayFailed(posthog, {
              source: playSource,
              reason,
              sequence_id: sequenceId,
            });
          }}
        />
      </div>
      {!meta && loading}
      {overlay}
    </div>
  );
};

const MusicToggle: React.FC<{
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}> = ({ enabled, onToggle, className }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-11 w-11 text-white hover:bg-white/10 hover:text-white md:h-8 md:w-8',
          className
        )}
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label={enabled ? 'Turn music off' : 'Turn music on'}
      >
        <span className="relative inline-flex">
          <Music className="h-5 w-5 md:h-4 md:w-4" />
          {!enabled && (
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-px w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current"
            />
          )}
        </span>
      </Button>
    </TooltipTrigger>
    <TooltipContent>
      {`${enabled ? 'Music on' : 'Music off'} — applies to playback and export`}
    </TooltipContent>
  </Tooltip>
);
