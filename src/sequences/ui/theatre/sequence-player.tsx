/**
 * Live in-browser theatre player. When `cachedVideoUrl` (an export whose input
 * hash matches the current scenes + music choice, #1253) is available it plays
 * that MP4 natively; otherwise it stitches scene videos + music via Mediabunny
 * on a canvas, under the same Video.js 10 skin (#1258).
 *
 * Falls back to an overlay message when the browser can't decode the source
 * codecs. Download/Copy live on `overlayActions` (theatre).
 */

import { Button } from '@/ui/shadcn/button';
import { VideoPlayer } from '@/motion/ui/video-player';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/models/aspect-ratios';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import type { SequencePlayerMeta } from './playback';
import type { SceneInput } from './concatenated-video-source';
import type { MotionDialogue } from '@/shots/scene-analysis.schema';
import { scenePlaybackKey } from './playback-scenes';
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
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

// Dynamic, and rendered only after mount — see stitched-player-surface.tsx.
// `@videojs/store` constructs an AbortController at module scope, which
// Workerd rejects (#1139). `lazy()` alone is not enough (React invokes the
// loader during SSR); the `mounted` gate is what keeps the server out of it.
const StitchedPlayerSurface = lazy(() => import('./stitched-player-surface'));

type SequencePlayerProps = {
  scenes: SceneInput[];
  onDialogueChange?: (
    dialogue: MotionDialogue | null | undefined,
    clip: { url: string; durationSeconds: number | null } | null | undefined
  ) => void;
  musicUrl: string | null;
  musicLoudnessGainDb: number | null;
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
  /**
   * A ready-made MP4 of exactly these scenes + music choice (the latest
   * export whose input hash matches). When set, plays natively instead of
   * stitching in the browser — one progressive download, instant first frame.
   * `undefined` = lookup still pending: show the poster and don't start the
   * stitching engine yet (it would be torn down the moment the cache lands).
   * `null` = no fresh export, stitch.
   */
  cachedVideoUrl: string | null | undefined;
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
};

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export const SequencePlayer: React.FC<SequencePlayerProps> = ({
  scenes,
  musicUrl,
  musicLoudnessGainDb,
  musicEnabled,
  onMusicEnabledChange,
  aspectRatio,
  className,
  overlayActions,
  cachedVideoUrl,
  playSource = 'theatre',
  sequenceId,
  autoPlay = false,
  onAutoPlayConsumed,
  onDialogueChange,
}) => {
  const posthog = usePostHog();
  const mounted = useMounted();
  const scenesKey = scenePlaybackKey(scenes);
  // An exported MP4 cannot represent shots that still have no video.
  const hasStills = scenes.some((scene) => !('videoUrl' in scene));
  if (hasStills) cachedVideoUrl = null;
  const sceneIndex = useRef(-1);
  const sceneOffsets = useRef<number[]>([]);
  const publishDialogue = (time: number, offsets: number[]) => {
    let index = offsets.length - 1;
    while (index > 0 && (offsets[index] ?? 0) > time) index--;
    if (index === sceneIndex.current) return;
    sceneIndex.current = index;
    const scene = scenes[index];
    onDialogueChange?.(scene?.dialogue, scene?.clip);
  };

  const [meta, setMeta] = useState<SequencePlayerMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedScenes, setLoadedScenes] = useState(0);

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

  // Drop stitch state when the cache lookup resolves to an MP4 or the clip
  // list changes, so a stale mixed-res warning / loading label cannot leak.
  // Flush watched here (not only on SequencePlayer unmount): the stitcher
  // can be torn down while this shell stays mounted (cache lands, clip list
  // changes) and detach does not emit `pause`.
  useEffect(() => {
    sceneIndex.current = -1;
    sceneOffsets.current = [];
    onDialogueChange?.(null, null);
    setMeta(null);
    setLoadedScenes(0);
    setError(null);
    flushWatched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scenesKey, not scenes identity (#1284)
  }, [scenesKey, musicUrl, musicLoudnessGainDb, cachedVideoUrl]);

  const frameClassName = cn(
    'relative w-full overflow-hidden rounded-lg bg-black',
    className,
    getAspectRatioClassName(aspectRatio)
  );

  const overlay = (
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
            Scenes use different resolutions ({meta.resolutionsLabel}) because
            they were generated by different models.{' '}
            {meta.hasMixedAspectRatios
              ? 'Playback letterboxes them into a common frame'
              : 'Smaller scenes are upscaled to match'}
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
  );

  if (cachedVideoUrl) {
    return (
      <div
        data-testid="sequence-player"
        data-state="ready"
        className={frameClassName}
      >
        {/* Same Video.js player + skin as the per-shot ScenePlayer, so the
            theatre's cached mode is visually identical to every other player
            in the app (#1253). */}
        <VideoPlayer
          src={cachedVideoUrl}
          aspectRatio={aspectRatio}
          className="absolute inset-0 h-full max-h-none w-full"
          autoPlay={autoPlay}
          playSource={playSource}
          sequenceId={sequenceId}
          onPlay={onAutoPlayConsumed}
        />
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
          {musicUrl && (
            <MusicToggle
              enabled={musicEnabled}
              onToggle={() => onMusicEnabledChange(!musicEnabled)}
              className="bg-black/50 hover:bg-black/70"
            />
          )}
          {overlayActions}
        </div>
      </div>
    );
  }

  const stitchError =
    error ??
    (scenes.length === 0 && cachedVideoUrl === null
      ? 'No scenes ready to play yet.'
      : null);

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
            : 'Export your sequence to download an MP4 you can play in any browser.'}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setMeta(null);
            setLoadedScenes(0);
            setError(null);
          }}
        >
          Retry playback
        </Button>
      </div>
    );
  }

  const loading = (
    <>
      <Skeleton
        data-testid="player-loading"
        className="absolute inset-0 z-10 h-full w-full bg-muted/40"
      />
      <p
        aria-live="polite"
        className="absolute inset-x-0 bottom-3 z-20 text-center text-xs text-white/80"
      >
        {cachedVideoUrl === undefined
          ? 'Loading…'
          : loadedScenes < scenes.length
            ? `Loading scene ${loadedScenes + 1} of ${scenes.length}…`
            : 'Preparing playback…'}
      </p>
    </>
  );

  return (
    <div
      data-testid="sequence-player"
      data-state={meta ? 'ready' : 'loading'}
      className={frameClassName}
    >
      {cachedVideoUrl === null && mounted ? (
        <Suspense fallback={null}>
          <div className="absolute inset-0 h-full w-full">
            <StitchedPlayerSurface
              scenes={scenes}
              musicUrl={musicUrl}
              musicLoudnessGainDb={musicLoudnessGainDb}
              musicEnabled={musicEnabled}
              autoPlay={autoPlay}
              onLoadProgress={(loaded) => setLoadedScenes(loaded)}
              onMeta={(next) => {
                setMeta(next);
                sceneOffsets.current = next.sceneOffsetsSeconds;
                publishDialogue(0, next.sceneOffsetsSeconds);
                tracker.setDuration(next.durationSeconds);
              }}
              onTimeUpdate={(t) => {
                tracker.tick(t);
                publishDialogue(t, sceneOffsets.current);
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
        </Suspense>
      ) : null}
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
      {enabled ? 'Music on' : 'Music off'} — applies to playback and export
    </TooltipContent>
  </Tooltip>
);
