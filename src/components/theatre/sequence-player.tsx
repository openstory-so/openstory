/**
 * Live in-browser theatre player. When `cachedVideoUrl` (an export whose input
 * hash matches the current scenes + music choice, #1253) is available it plays
 * that MP4 natively; otherwise it stitches scene videos + music via Mediabunny
 * on a canvas.
 *
 * Falls back to a CTA ("Export as MP4 to download") when the browser can't
 * decode the source codecs. The export pipeline lives in
 * `src/lib/sequence-player/export.ts`.
 */

import { Button } from '@/components/ui/button';
import { VideoPlayer } from '@/components/motion/video-player';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  SequencePlayerEngine,
  type SequencePlayerMeta,
} from '@/lib/sequence-player/playback';
import type { SceneInput } from '@/lib/sequence-player/concatenated-video-source';
import { scenePlaybackKey } from '@/lib/sequence-player/playback-scenes';
import {
  playAttemptUiState,
  type PlayAttemptResult,
} from '@/lib/sequence-player/play-attempt';
import {
  captureSequenceReadySeen,
  captureVideoPlay,
  captureVideoPlayFailed,
  type VideoPlaySource,
} from '@/lib/observability/player-events';
import { cn } from '@/lib/utils';
import { usePostHog } from '@posthog/react';
import {
  AlertCircle,
  Maximize,
  Minimize,
  Music,
  Pause,
  Play,
  TriangleAlert,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type SequencePlayerProps = {
  scenes: SceneInput[];
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
  /** Still shown behind the loading state (and as the native `<video>` poster) so the user isn't staring at a blank skeleton (#1253). */
  posterUrl?: string | null;
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
};

export const SequencePlayer: React.FC<SequencePlayerProps> = ({
  scenes,
  musicUrl,
  musicLoudnessGainDb,
  musicEnabled,
  onMusicEnabledChange,
  aspectRatio,
  className,
  overlayActions,
  posterUrl,
  cachedVideoUrl,
  playSource = 'theatre',
  sequenceId,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SequencePlayerEngine | null>(null);
  const posthog = usePostHog();
  const readyKeyRef = useRef<string | null>(null);
  const playEpochRef = useRef(0);
  const scenesKey = scenePlaybackKey(scenes);

  const [meta, setMeta] = useState<SequencePlayerMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [loadedScenes, setLoadedScenes] = useState(0);

  const markReady = (key: string) => {
    if (!sequenceId || readyKeyRef.current === key) return;
    readyKeyRef.current = key;
    captureSequenceReadySeen(posthog, {
      sequence_id: sequenceId,
      scene_count: scenes.length,
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cachedVideoUrl !== null) return;
    setMeta(null);
    setLoadedScenes(0);
    setError(null);
    // Rebuild starts paused at 0:00. Do not auto-resume — play is a user
    // gesture. Clearing `playing` avoids a Pause icon on an engine that is
    // not playing. Bump the epoch so an in-flight play() from the old engine
    // cannot set playing back to true.
    playEpochRef.current += 1;
    setPlaying(false);
    setCurrentTime(0);
    if (scenes.length === 0) {
      setError('No scenes ready to play yet.');
      return;
    }

    let cancelled = false;
    const engine = new SequencePlayerEngine({
      canvas,
      scenes,
      musicUrl,
      musicLoudnessGainDb,
      musicEnabled,
      onLoadProgress: (loaded) => {
        if (!cancelled) setLoadedScenes(loaded);
      },
      onTimeUpdate: (t) => {
        if (!cancelled) setCurrentTime(t);
      },
      onEnded: () => {
        if (!cancelled) setPlaying(false);
      },
      onError: (err) => {
        if (!cancelled) setError(err.message);
      },
    });
    engineRef.current = engine;

    engine
      .prepare()
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        markReady(`stitch:${scenesKey}`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load video');
      });

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
    // `scenesKey` (URLs + order), not `scenes` identity — a same-URL refetch
    // used to dispose the engine mid-play (#1284). musicUrl / loudness / cache
    // still rebuild; volume/muted/musicEnabled go through setters (#834).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenesKey, musicUrl, musicLoudnessGainDb, cachedVideoUrl]);

  useEffect(() => {
    if (!cachedVideoUrl) return;
    markReady(`cached:${cachedVideoUrl}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedVideoUrl, sequenceId, scenesKey]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    engineRef.current?.setMusicEnabled(musicEnabled);
  }, [musicEnabled]);

  const applyPlayResult = (epoch: number, result: PlayAttemptResult): void => {
    if (epoch !== playEpochRef.current) return;
    const ui = playAttemptUiState(result);
    setPlaying(ui.playing);
    if (ui.playing) {
      captureVideoPlay(posthog, {
        source: playSource,
        sequence_id: sequenceId,
      });
      return;
    }
    if (ui.failureReason) {
      captureVideoPlayFailed(posthog, {
        source: playSource,
        reason: ui.failureReason,
        sequence_id: sequenceId,
      });
    }
  };

  const togglePlay = () => {
    const engine = engineRef.current;
    if (!engine) {
      captureVideoPlayFailed(posthog, {
        source: playSource,
        reason: 'no_engine',
        sequence_id: sequenceId,
      });
      return;
    }
    // Branch on React state, not engine.isPlaying(): the first play() waits on
    // background dialogue decode and the engine isn't "playing" until then.
    // Optimistic Pause during that wait; pause() cancels the pending play.
    if (playing) {
      playEpochRef.current += 1;
      engine.pause();
      setPlaying(false);
      return;
    }
    const epoch = ++playEpochRef.current;
    setPlaying(true);
    void engine
      .play()
      .then((result) => applyPlayResult(epoch, result))
      .catch((err: unknown) => {
        if (epoch !== playEpochRef.current) return;
        setPlaying(false);
        captureVideoPlayFailed(posthog, {
          source: playSource,
          reason: err instanceof Error ? err.message : 'play_rejected',
          sequence_id: sequenceId,
        });
      });
  };

  const seek = (seconds: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const epoch = playEpochRef.current;
    void engine
      .seek(seconds)
      .then((result) => {
        if (result == null) return;
        applyPlayResult(epoch, result);
      })
      .catch((err: unknown) => {
        if (epoch !== playEpochRef.current) return;
        setPlaying(false);
        captureVideoPlayFailed(posthog, {
          source: playSource,
          reason: err instanceof Error ? err.message : 'play_rejected',
          sequence_id: sequenceId,
        });
      });
  };

  if (cachedVideoUrl) {
    return (
      <div
        data-testid="sequence-player"
        data-state="ready"
        className={cn(
          'relative w-full overflow-hidden rounded-lg bg-black',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      >
        {/* Same Video.js player + skin as the per-shot ScenePlayer, so the
            theatre's cached mode is visually identical to every other player
            in the app (#1253). */}
        <VideoPlayer
          src={cachedVideoUrl}
          posterSrc={posterUrl}
          aspectRatio={aspectRatio}
          className="absolute inset-0 h-full max-h-none w-full"
          playSource={playSource}
          sequenceId={sequenceId}
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

  if (error) {
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
        <p className="text-sm text-muted-foreground text-center">{error}</p>
        <p className="text-xs text-muted-foreground text-center max-w-sm">
          Export your sequence to download an MP4 you can play in any browser.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="sequence-player"
      data-state={meta ? 'ready' : 'loading'}
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-black',
        className,
        getAspectRatioClassName(aspectRatio)
      )}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full object-contain"
        aria-label="Sequence playback"
      />
      {!meta && (
        <>
          {posterUrl && (
            <img
              src={posterUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-contain opacity-60"
            />
          )}
          <Skeleton
            data-testid="player-loading"
            className="absolute inset-0 h-full w-full bg-muted/40"
          />
          <p
            aria-live="polite"
            className="absolute inset-x-0 bottom-3 text-center text-xs text-white/80"
          >
            {cachedVideoUrl === undefined
              ? 'Loading…'
              : loadedScenes < scenes.length
                ? `Loading scene ${loadedScenes + 1} of ${scenes.length}…`
                : 'Preparing playback…'}
          </p>
        </>
      )}
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
      {meta && (
        <PlayerControls
          playing={playing}
          currentTime={currentTime}
          duration={meta.durationSeconds}
          volume={volume}
          muted={muted || !meta.hasAudio}
          hasAudio={meta.hasAudio}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onVolumeChange={setVolume}
          onToggleMute={() => setMuted((m) => !m)}
          containerRef={containerRef}
        />
      )}
    </div>
  );
};

type PlayerControlsProps = {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  hasAudio: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
};

const PlayerControls: React.FC<PlayerControlsProps> = ({
  playing,
  currentTime,
  duration,
  volume,
  muted,
  hasAudio,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onToggleMute,
  containerRef,
}) => {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenEnabled, setFullscreenEnabled] = useState(false);

  useEffect(() => {
    setFullscreenEnabled(document.fullscreenEnabled);
    const sync = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [containerRef]);

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
      <button
        type="button"
        aria-label="Seek"
        className="group relative flex min-h-11 cursor-pointer items-center md:h-2 md:min-h-0"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const fraction = (e.clientX - rect.left) / rect.width;
          onSeek(fraction * duration);
        }}
      >
        <div className="relative h-3 w-full rounded-full bg-white/20 md:h-2">
          <div
            className="h-full rounded-full bg-white transition-[width] duration-75"
            style={{ width: `${progress}%` }}
          />
        </div>
      </button>
      <div className="flex items-center gap-3 text-white">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 text-white hover:bg-white/10 hover:text-white md:h-8 md:w-8"
          onClick={onTogglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <Pause className="h-5 w-5 md:h-4 md:w-4" />
          ) : (
            <Play className="h-5 w-5 md:h-4 md:w-4" />
          )}
        </Button>
        <span className="text-xs tabular-nums">
          {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
        </span>
        <div className="flex-1" />
        {hasAudio && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 text-white hover:bg-white/10 hover:text-white md:h-8 md:w-8"
              onClick={onToggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? (
                <VolumeX className="h-5 w-5 md:h-4 md:w-4" />
              ) : (
                <Volume2 className="h-5 w-5 md:h-4 md:w-4" />
              )}
            </Button>
            {/* iOS/Android hardware volume owns loudness; a desktop-only range
                just crowds the play/time/fullscreen row. */}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="hidden h-1 w-20 accent-white md:block"
              aria-label="Volume"
            />
          </div>
        )}
        {fullscreenEnabled && (
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 text-white hover:bg-white/10 hover:text-white md:h-8 md:w-8"
            onClick={() => {
              const el = containerRef.current;
              if (!el) return;
              if (document.fullscreenElement === el) {
                void document.exitFullscreen();
                return;
              }
              void el.requestFullscreen().catch(() => undefined);
            }}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {isFullscreen ? (
              <Minimize className="h-5 w-5 md:h-4 md:w-4" />
            ) : (
              <Maximize className="h-5 w-5 md:h-4 md:w-4" />
            )}
          </Button>
        )}
      </div>
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

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
