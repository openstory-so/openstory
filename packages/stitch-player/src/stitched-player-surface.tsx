/**
 * The Video.js-dependent half of the stitching player: the canvas under the
 * `NeutralVideoSkin`, a subtitle layer, and the optional Download button.
 *
 * Client only: `@videojs/react` pulls in `@videojs/store`, which constructs
 * `AbortController` at module scope; server runtimes such as Cloudflare
 * Workers reject that. `react.tsx` is the entry: it loads this module on the
 * client, after render, and nothing else imports it.
 *
 * Subtitles are drawn here, not by the browser: there is no `<video>` for the
 * native cue renderer. The layer reads `media.activeCueText`, so the skin's
 * captions button and `c` hotkey toggle it, and it lifts above the controls
 * through the skin's own `--media-caption-track-y` variable. Style it from
 * outside via `[data-part="stitch-captions"]`.
 */

import { useMediaInstance } from '@videojs/react';
import { NeutralVideoSkin, VideoPlayer } from '@videojs/react/video';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';

import { downloadSequence, type ExportSequenceSettings } from './export.js';
import type { StitchLogger } from './logger.js';
import type { PlaybackClip } from './playback-clip.js';
import type { SequencePlayerMeta } from './playback.js';
import { StitchedSequenceMedia } from './stitched-media.js';

export type StitchedPlayerSurfaceProps = {
  clips: readonly PlaybackClip[];
  musicUrl: string | null;
  /** Gain in dB on the music only; 0 for none. */
  musicGainDb: number;
  musicEnabled: boolean;
  /**
   * Whether subtitles show when a clip has cues. Defaults to true. A change
   * applies live; a re-render with the same value leaves the viewer's own
   * captions toggle alone.
   */
  subtitles?: boolean;
  autoPlay?: boolean;
  /** Class for the skin root, which fills its parent. */
  className?: string;
  /** Where the engine reports non-fatal problems. Defaults to `console`. */
  logger?: StitchLogger;
  /**
   * Show a Download button (top right), enabled once the clips are open. It
   * pauses, exports in the browser from the clips the player already opened,
   * and saves the MP4 — plus a `.vtt` sidecar unless `subtitles` says
   * otherwise. See `downloadSequence`.
   */
  download?: Pick<ExportSequenceSettings, 'subtitles' | 'frameRate'> & {
    /** Defaults to `sequence.mp4`. */
    filename?: string;
  };
  onLoadProgress?: (loadedClips: number, totalClips: number) => void;
  onMeta?: (meta: SequencePlayerMeta) => void;
  onLoadedMetadata?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  /** Playback is broken (a clip would not open or decode, a play or seek failed). */
  onError?: (error: Error) => void;
  /** Picture-in-Picture was refused; playback goes on. */
  onPictureInPictureError?: (error: Error) => void;
};

const fill: CSSProperties = { width: '100%', height: '100%' };

const downloadLayer: CSSProperties = {
  position: 'absolute',
  top: '0.5rem',
  right: '0.5rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: '0.25rem',
  font: 'inherit',
};

const downloadButton: CSSProperties = {
  padding: '0.4em 0.8em',
  border: 0,
  borderRadius: '0.4em',
  background: 'rgba(0, 0, 0, 0.6)',
  color: '#fff',
  font: 'inherit',
  fontSize: '0.875rem',
  cursor: 'pointer',
};

const downloadError: CSSProperties = {
  margin: 0,
  padding: '0.3em 0.6em',
  borderRadius: '0.4em',
  background: 'rgba(0, 0, 0, 0.6)',
  color: '#fca5a5',
  fontSize: '0.75rem',
};

type DownloadProps = NonNullable<StitchedPlayerSurfaceProps['download']>;

const Download: React.FC<{
  media: StitchedSequenceMedia;
  music: Pick<
    StitchedPlayerSurfaceProps,
    'musicUrl' | 'musicGainDb' | 'musicEnabled' | 'logger'
  >;
  options: DownloadProps;
}> = ({ media, music, options }) => {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Enabled once the engine has opened the clips, so the export reads from
  // that source and never opens the clips a second time.
  const ready = useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        for (const type of ['loadedmetadata', 'emptied']) {
          media.addEventListener(type, notify);
        }
        return () => {
          for (const type of ['loadedmetadata', 'emptied']) {
            media.removeEventListener(type, notify);
          }
        };
      },
      [media]
    ),
    () => media.meta !== null,
    () => false
  );
  const run = async () => {
    const source = media.engine?.source;
    if (!source) return;
    media.pause();
    setError(null);
    setProgress(0);
    try {
      await downloadSequence({
        ...music,
        ...options,
        source,
        onProgress: setProgress,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setProgress(null);
  };
  return (
    <div data-part="stitch-download" style={downloadLayer}>
      <button
        type="button"
        style={downloadButton}
        disabled={!ready || progress !== null}
        onClick={() => void run()}
      >
        {progress === null
          ? 'Download'
          : `Exporting… ${Math.round(progress * 100)}%`}
      </button>
      {error ? (
        <p role="alert" style={downloadError}>
          {error}
        </p>
      ) : null}
    </div>
  );
};

const captionsLayer: CSSProperties = {
  position: 'absolute',
  insetInline: 0,
  bottom: 0,
  display: 'flex',
  justifyContent: 'center',
  padding: '0 6%',
  pointerEvents: 'none',
  transform: 'translateY(var(--media-caption-track-y, 0px))',
  transition:
    'transform var(--media-caption-track-duration, 100ms) var(--media-controls-transition-timing-function, ease-out)',
};

const captionsText: CSSProperties = {
  maxWidth: '100%',
  padding: '0.15em 0.5em',
  borderRadius: '0.2em',
  background: 'rgba(0, 0, 0, 0.65)',
  color: '#fff',
  fontSize: 'clamp(14px, 3.2cqi, 30px)',
  lineHeight: 1.3,
  textAlign: 'center',
  whiteSpace: 'pre-line',
  textWrap: 'balance',
  textShadow: '0 0 2px rgba(0, 0, 0, 0.8)',
};

const Captions: React.FC<{ media: StitchedSequenceMedia }> = ({ media }) => {
  const subscribe = useCallback(
    (notify: () => void) => {
      const mediaEvents = ['timeupdate', 'seeked', 'loadedmetadata', 'emptied'];
      const trackEvents = ['change', 'addtrack', 'removetrack'];
      for (const type of mediaEvents) media.addEventListener(type, notify);
      for (const type of trackEvents) {
        media.textTracks.addEventListener(type, notify);
      }
      return () => {
        for (const type of mediaEvents) media.removeEventListener(type, notify);
        for (const type of trackEvents) {
          media.textTracks.removeEventListener(type, notify);
        }
      };
    },
    [media]
  );
  const text = useSyncExternalStore(
    subscribe,
    () => media.activeCueText,
    () => null
  );
  if (text === null) return null;
  return (
    <div data-part="stitch-captions" style={captionsLayer}>
      <span style={captionsText}>{text}</span>
    </div>
  );
};

const StitchedPlayerInner: React.FC<StitchedPlayerSurfaceProps> = ({
  clips,
  musicUrl,
  musicGainDb,
  musicEnabled,
  subtitles = true,
  autoPlay = false,
  className,
  logger,
  download,
  onLoadProgress,
  onMeta,
  onLoadedMetadata,
  onTimeUpdate,
  onPlay,
  onPause,
  onEnded,
  onError,
  onPictureInPictureError,
}) => {
  const media = useMediaInstance(StitchedSequenceMedia);
  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (el) media.attach(el);
      else media.detach();
      return () => media.detach();
    },
    [media]
  );

  const callbacksRef = useRef({
    onLoadProgress,
    onMeta,
    onLoadedMetadata,
    onTimeUpdate,
    onPlay,
    onPause,
    onEnded,
    onError,
    onPictureInPictureError,
  });
  callbacksRef.current = {
    onLoadProgress,
    onMeta,
    onLoadedMetadata,
    onTimeUpdate,
    onPlay,
    onPause,
    onEnded,
    onError,
    onPictureInPictureError,
  };

  useEffect(() => {
    media.setListeners({
      logger,
      onLoadProgress: (loaded, total) => {
        callbacksRef.current.onLoadProgress?.(loaded, total);
      },
      onMeta: (meta) => {
        callbacksRef.current.onMeta?.(meta);
      },
      onError: (error) => {
        callbacksRef.current.onError?.(error);
      },
      onPictureInPictureError: (error) => {
        callbacksRef.current.onPictureInPictureError?.(error);
      },
    });
  }, [media, logger]);

  useEffect(() => {
    media.setSource({
      clips,
      musicUrl,
      musicGainDb,
      musicEnabled,
      subtitles,
    });
    // musicEnabled is in the payload but must not rebuild: setMusicEnabled
    // applies it live. Clip-list identity is decided inside setSource
    // (playbackClipsKey + music URL/gain), not by this array's identity, so a
    // new array of the same clips — or new cues — never rebuilds the engine.
    // `subtitles` is here because setSource applies a change to it live too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, clips, musicUrl, musicGainDb, subtitles]);

  useEffect(() => {
    media.setMusicEnabled(musicEnabled);
  }, [media, musicEnabled]);

  useEffect(() => {
    const handleLoadedMetadata = () => {
      callbacksRef.current.onLoadedMetadata?.(media.duration);
    };
    const handleTimeUpdate = () => {
      callbacksRef.current.onTimeUpdate?.(media.currentTime);
    };
    // `playing` also fires when a buffering stall clears; only the first
    // one after a pause is a play.
    let started = false;
    const handlePlaying = () => {
      if (started) return;
      started = true;
      callbacksRef.current.onPlay?.();
    };
    const handlePause = () => {
      started = false;
      callbacksRef.current.onPause?.();
    };
    const handleEnded = () => {
      started = false;
      callbacksRef.current.onEnded?.();
    };

    media.addEventListener('loadedmetadata', handleLoadedMetadata);
    media.addEventListener('timeupdate', handleTimeUpdate);
    // `playing`, not `play`: a first play() waits on dialogue decode, and a
    // stall timer must not start until the engine is actually moving.
    media.addEventListener('playing', handlePlaying);
    media.addEventListener('pause', handlePause);
    media.addEventListener('ended', handleEnded);

    return () => {
      media.removeEventListener('loadedmetadata', handleLoadedMetadata);
      media.removeEventListener('timeupdate', handleTimeUpdate);
      media.removeEventListener('playing', handlePlaying);
      media.removeEventListener('pause', handlePause);
      media.removeEventListener('ended', handleEnded);
    };
  }, [media]);

  useEffect(() => {
    if (!autoPlay) return;
    const start = () => {
      void media.play().catch(() => {
        // Autoplay blocked or interrupted — the on-player control remains.
      });
    };
    if (media.readyState >= 1) {
      start();
      return;
    }
    media.addEventListener('loadedmetadata', start, { once: true });
    return () => media.removeEventListener('loadedmetadata', start);
  }, [autoPlay, media]);

  return (
    <NeutralVideoSkin className={className}>
      <div
        style={{ ...fill, position: 'relative', containerType: 'inline-size' }}
      >
        <canvas
          ref={canvasRef}
          style={{ ...fill, display: 'block', objectFit: 'contain' }}
          aria-label="Sequence playback"
        />
        <Captions media={media} />
        {download ? (
          <Download
            media={media}
            music={{ musicUrl, musicGainDb, musicEnabled, logger }}
            options={download}
          />
        ) : null}
      </div>
    </NeutralVideoSkin>
  );
};

export const StitchedPlayerSurface: React.FC<StitchedPlayerSurfaceProps> = (
  props
) => (
  <VideoPlayer>
    <StitchedPlayerInner {...props} />
  </VideoPlayer>
);
