/**
 * The Video.js-dependent half of {@link VideoPlayer}.
 *
 * This module exists to be a LOADING BOUNDARY, not just an organisational one:
 * importing `@videojs/react` pulls in `@videojs/store`, whose `selector.js`
 * builds a module-scope singleton containing `new AbortController()`. Workerd
 * forbids constructing an I/O-bound object at global scope, so merely importing
 * this module on the server throws "Disallowed operation called within global
 * scope" — once per isolate cold start, ~179×/day in production (#1139).
 *
 * No lazy-call workaround can help, because the throw happens on IMPORT, before
 * any of our code runs. Keeping every `@videojs/*` import in here lets
 * `video-player.tsx` reach it through a client-only dynamic import, so the
 * server never evaluates it.
 *
 * Nothing may import this module statically from a server-reachable path.
 */

import type { Media, Video as VideoMedia } from '@videojs/media';
import { createPlayer, Poster, useMedia } from '@videojs/react';
import { MinimalVideoSkin, Video, videoFeatures } from '@videojs/react/video';
import { useEffect, useRef } from 'react';

// useMedia() returns the base Media capability set; the <Video> component
// renders an instance with the full Video capability set (seek/source/etc.).
// Types live in @videojs/media as of v10 beta.26 (no longer re-exported from
// @videojs/core).
const isVideoMedia = (media: Media): media is VideoMedia =>
  'duration' in media && 'currentTime' in media;

// `createPlayer` also constructs an AbortController, so it stays out of module
// scope even here: this module is only ever evaluated in the browser, but the
// singleton is still the right shape — one player instance shared across every
// mount, built on first render.
let playerSingleton: ReturnType<typeof createPlayer> | undefined;
const getPlayer = () =>
  (playerSingleton ??= createPlayer({ features: videoFeatures }));

type VideoPlayerSurfaceProps = {
  src: string;
  chaptersUrl?: string;
  posterSrc?: string | null;
  autoPlay?: boolean;
  onLoadedMetadata?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPause?: () => void;
  onEnded?: () => void;
  onPlay?: () => void;
  onError?: (reason: string) => void;
};

const VideoPlayerInner: React.FC<VideoPlayerSurfaceProps> = ({
  src,
  chaptersUrl,
  posterSrc,
  autoPlay = false,
  onLoadedMetadata,
  onTimeUpdate,
  onPause,
  onEnded,
  onPlay,
  onError,
}) => {
  const media = useMedia();
  const callbacksRef = useRef({
    onLoadedMetadata,
    onTimeUpdate,
    onPause,
    onEnded,
    onPlay,
    onError,
  });
  callbacksRef.current = {
    onLoadedMetadata,
    onTimeUpdate,
    onPause,
    onEnded,
    onPlay,
    onError,
  };

  useEffect(() => {
    if (!media || !isVideoMedia(media)) return;
    const el = media;

    const handleLoadedMetadata = () => {
      callbacksRef.current.onLoadedMetadata?.(el.duration);
    };
    const handleTimeUpdate = () => {
      callbacksRef.current.onTimeUpdate?.(el.currentTime);
    };
    const handlePause = () => {
      callbacksRef.current.onPause?.();
    };
    const handleEnded = () => {
      callbacksRef.current.onEnded?.();
    };
    const handlePlay = () => {
      callbacksRef.current.onPlay?.();
    };
    const handleError = () => {
      const mediaError =
        'error' in el
          ? (el as { error?: { message?: string; code?: number } | null }).error
          : null;
      const reason = mediaError?.message
        ? mediaError.message
        : mediaError?.code
          ? `media_error_${mediaError.code}`
          : 'media_error';
      callbacksRef.current.onError?.(reason);
    };

    el.addEventListener('loadedmetadata', handleLoadedMetadata);
    el.addEventListener('timeupdate', handleTimeUpdate);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handleEnded);
    el.addEventListener('play', handlePlay);
    el.addEventListener('error', handleError);

    return () => {
      el.removeEventListener('loadedmetadata', handleLoadedMetadata);
      el.removeEventListener('timeupdate', handleTimeUpdate);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('ended', handleEnded);
      el.removeEventListener('play', handlePlay);
      el.removeEventListener('error', handleError);
    };
  }, [media]);

  return (
    <MinimalVideoSkin>
      <Video
        src={src || undefined}
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
      >
        {chaptersUrl && <track kind="chapters" src={chaptersUrl} default />}
      </Video>
      {posterSrc && <Poster src={posterSrc} alt="Video thumbnail" />}
    </MinimalVideoSkin>
  );
};

/**
 * Default export so `video-player.tsx` can reach this through `React.lazy`,
 * which requires a module whose default is the component.
 */
const VideoPlayerSurface: React.FC<VideoPlayerSurfaceProps> = (props) => {
  const Player = getPlayer();
  return (
    <Player.Provider>
      <VideoPlayerInner {...props} />
    </Player.Provider>
  );
};

export default VideoPlayerSurface;
