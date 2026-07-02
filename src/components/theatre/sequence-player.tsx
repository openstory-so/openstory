/**
 * Live in-browser theatre player. Stitches scene videos + a single music track
 * via Mediabunny, without ever producing a merged-MP4 artifact server-side.
 *
 * Falls back to a CTA ("Export as MP4 to download") when the browser can't
 * decode the source codecs — this is the only path to a fallback. The export
 * pipeline lives in `src/lib/sequence-player/export.ts`.
 */

import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  Music,
  Pause,
  Play,
  TriangleAlert,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Imperative handle for the canvas/spine to drive playback (#986): the spine
 * seeks by shot, the keyboard grammar's Space toggles play. Exposed via the
 * `controlsRef` prop rather than events so callers can act at interaction
 * time without re-rendering the player.
 */
export type SequencePlayerControls = {
  /** Seek to the start of the Nth scene (playback order). */
  seekToScene: (index: number) => void;
  togglePlay: () => void;
  isPlaying: () => boolean;
};

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
  /** Persist the music on/off choice (see TheatreView → setSequenceMusicFn). */
  onMusicEnabledChange: (enabled: boolean) => void;
  aspectRatio: AspectRatio;
  className?: string;
  /** Slot rendered as an overlay (top-right) — e.g. the Share dropdown. */
  overlayActions?: React.ReactNode;
  /**
   * Fired when the playhead crosses into a different scene (#986) — lets the
   * spine/filmstrip highlight the shot that is actually playing. Reports -1
   * before metadata is ready.
   */
  onActiveSceneChange?: (index: number) => void;
  /** Receives the imperative playback controls; nulled on unmount. */
  controlsRef?: React.RefObject<SequencePlayerControls | null>;
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
  onActiveSceneChange,
  controlsRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SequencePlayerEngine | null>(null);
  const activeSceneRef = useRef(-1);
  // Mirrors the `meta` state for the imperative controls, which must read the
  // latest offsets without re-registering on every prepare.
  const metaRef = useRef<SequencePlayerMeta | null>(null);

  const [meta, setMeta] = useState<SequencePlayerMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (scenes.length === 0) {
      setError('No scenes ready to play yet.');
      return;
    }

    // Re-preparing for a different playback set (#986: selection re-scopes
    // the player) must not leave the previous run's clock/meta on screen.
    setMeta(null);
    setPlaying(false);
    setCurrentTime(0);
    activeSceneRef.current = -1;

    let cancelled = false;
    const engine = new SequencePlayerEngine({
      canvas,
      scenes,
      musicUrl,
      musicLoudnessGainDb,
      musicEnabled,
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
        metaRef.current = m;
        setMeta(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load video');
      });

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
      metaRef.current = null;
      activeSceneRef.current = -1;
    };
    // The scene list/music identity drives the engine lifecycle; volume/muted/
    // musicEnabled are pushed through setters below (toggling music must not
    // re-prepare the engine, #834).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, musicUrl, musicLoudnessGainDb]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    engineRef.current?.setMusicEnabled(musicEnabled);
  }, [musicEnabled]);

  // Map the playhead to the scene it's inside and report crossings (#986).
  useEffect(() => {
    if (!onActiveSceneChange) return;
    const offsets = meta?.sceneOffsetsSeconds ?? [];
    let index = -1;
    for (let i = offsets.length - 1; i >= 0; i--) {
      const offset = offsets[i];
      if (offset !== undefined && currentTime >= offset) {
        index = i;
        break;
      }
    }
    if (index !== activeSceneRef.current) {
      activeSceneRef.current = index;
      onActiveSceneChange(index);
    }
  }, [currentTime, meta, onActiveSceneChange]);

  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      seekToScene: (index: number) => {
        const engine = engineRef.current;
        const offset = metaRef.current?.sceneOffsetsSeconds[index];
        if (engine && offset !== undefined) void engine.seek(offset);
      },
      togglePlay: () => {
        const engine = engineRef.current;
        if (!engine) return;
        if (engine.isPlaying()) {
          engine.pause();
          setPlaying(false);
        } else {
          void engine.play().then(() => setPlaying(true));
        }
      },
      isPlaying: () => engineRef.current?.isPlaying() ?? false,
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef]);

  const togglePlay = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.isPlaying()) {
      engine.pause();
      setPlaying(false);
    } else {
      void engine.play().then(() => setPlaying(true));
    }
  };

  const seek = (seconds: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.seek(seconds);
  };

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
        <Skeleton
          data-testid="player-loading"
          className="absolute inset-0 h-full w-full bg-muted/40"
        />
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
          hasMusic={Boolean(musicUrl)}
          musicEnabled={musicEnabled}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onVolumeChange={setVolume}
          onToggleMute={() => setMuted((m) => !m)}
          onToggleMusic={() => onMusicEnabledChange(!musicEnabled)}
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
  /** The sequence has a music track, so the music on/off toggle is shown. */
  hasMusic: boolean;
  musicEnabled: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  onToggleMusic: () => void;
};

const PlayerControls: React.FC<PlayerControlsProps> = ({
  playing,
  currentTime,
  duration,
  volume,
  muted,
  hasAudio,
  hasMusic,
  musicEnabled,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onToggleMusic,
}) => {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
      <button
        type="button"
        aria-label="Seek"
        className="group relative h-2 cursor-pointer rounded-full bg-white/20"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const fraction = (e.clientX - rect.left) / rect.width;
          onSeek(fraction * duration);
        }}
      >
        <div
          className="h-full rounded-full bg-white transition-[width] duration-75"
          style={{ width: `${progress}%` }}
        />
      </button>
      <div className="flex items-center gap-3 text-white">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
          onClick={onTogglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>
        <span className="text-xs tabular-nums">
          {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
        </span>
        <div className="flex-1" />
        {hasMusic && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
                onClick={onToggleMusic}
                aria-pressed={musicEnabled}
                aria-label={musicEnabled ? 'Turn music off' : 'Turn music on'}
              >
                <span className="relative inline-flex">
                  <Music className="h-4 w-4" />
                  {!musicEnabled && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-1/2 h-px w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current"
                    />
                  )}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {musicEnabled ? 'Music on' : 'Music off'} — applies to playback
              and export
            </TooltipContent>
          </Tooltip>
        )}
        {hasAudio && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
              onClick={onToggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="h-1 w-20 accent-white"
              aria-label="Volume"
            />
          </div>
        )}
      </div>
    </div>
  );
};

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
