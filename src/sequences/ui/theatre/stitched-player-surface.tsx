/**
 * The Video.js-dependent half of the theatre stitching player.
 *
 * Same loading-boundary rule as `video-player-surface.tsx`: `@videojs/react`
 * pulls in `@videojs/store`, which constructs `AbortController` at module
 * scope. Workerd forbids that (#1139). `sequence-player.tsx` reaches this
 * module through a client-only dynamic import.
 *
 * Nothing may import this module statically from a server-reachable path.
 */

import { createPlayer, useMediaInstance } from '@videojs/react';
import { VideoSkin, videoFeatures } from '@videojs/react/video';
import { useCallback, useEffect, useRef } from 'react';

import type { SceneInput } from './concatenated-video-source';
import type { SequencePlayerMeta } from './playback';
import { StitchedSequenceMedia } from './stitched-media';

let playerSingleton: ReturnType<typeof createPlayer> | undefined;
const getPlayer = () =>
  (playerSingleton ??= createPlayer({ features: videoFeatures }));

type StitchedPlayerSurfaceProps = {
  scenes: SceneInput[];
  musicUrl: string | null;
  musicLoudnessGainDb: number | null;
  musicEnabled: boolean;
  autoPlay?: boolean;
  onLoadProgress?: (loadedScenes: number, totalScenes: number) => void;
  onMeta?: (meta: SequencePlayerMeta) => void;
  onLoadedMetadata?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onError?: (reason: string) => void;
};

const StitchedPlayerInner: React.FC<StitchedPlayerSurfaceProps> = ({
  scenes,
  musicUrl,
  musicLoudnessGainDb,
  musicEnabled,
  autoPlay = false,
  onLoadProgress,
  onMeta,
  onLoadedMetadata,
  onTimeUpdate,
  onPlay,
  onPause,
  onEnded,
  onError,
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
  };

  useEffect(() => {
    media.setListeners({
      onLoadProgress: (loaded, total) => {
        callbacksRef.current.onLoadProgress?.(loaded, total);
      },
      onMeta: (meta) => {
        callbacksRef.current.onMeta?.(meta);
      },
      onError: (error) => {
        callbacksRef.current.onError?.(error.message);
      },
    });
  }, [media]);

  useEffect(() => {
    media.setSource({
      scenes,
      musicUrl,
      musicLoudnessGainDb,
      musicEnabled,
    });
    // musicEnabled is in the payload but must not rebuild: setMusicEnabled
    // applies it live (#834). Clip-list identity is decided inside setSource
    // (scenePlaybackKey + music URL/loudness), not by this array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, scenes, musicUrl, musicLoudnessGainDb]);

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
    const handlePlaying = () => {
      callbacksRef.current.onPlay?.();
    };
    const handlePause = () => {
      callbacksRef.current.onPause?.();
    };
    const handleEnded = () => {
      callbacksRef.current.onEnded?.();
    };

    media.addEventListener('loadedmetadata', handleLoadedMetadata);
    media.addEventListener('timeupdate', handleTimeUpdate);
    // `playing`, not `play`: first play() waits on dialogue decode, and
    // analytics must not start the stall timer until the engine is actually
    // moving (#1253 / #1301).
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
    <VideoSkin className="h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full object-contain"
        aria-label="Sequence playback"
      />
    </VideoSkin>
  );
};

const StitchedPlayerSurface: React.FC<StitchedPlayerSurfaceProps> = (props) => {
  const Player = getPlayer();
  return (
    <Player.Provider>
      <StitchedPlayerInner {...props} />
    </Player.Provider>
  );
};

export default StitchedPlayerSurface;
