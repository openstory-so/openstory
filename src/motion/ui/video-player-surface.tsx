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
import { Poster, useMedia } from '@videojs/react';
import { NeutralVideoSkin, Video, VideoPlayer } from '@videojs/react/video';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

import { showingCaptionText } from './showing-caption';

// useMedia() returns the base Media capability set; the <Video> component
// renders an instance with the full Video capability set (seek/source/etc.).
// Types live in @videojs/media (not re-exported from @videojs/core).
const isVideoMedia = (media: Media | null): media is VideoMedia =>
  media != null && 'duration' in media && 'currentTime' in media;

type VideoPlayerSurfaceProps = {
  src: string;
  chaptersUrl?: string;
  subtitlesUrl?: string;
  posterSrc?: string | null;
  autoPlay?: boolean;
  /** Seek here when the value changes (packed-clip shot windows). */
  seekTo?: number | null;
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
  subtitlesUrl,
  posterSrc,
  autoPlay = false,
  seekTo,
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

  useEffect(() => {
    if (!autoPlay || !media || !isVideoMedia(media)) return;
    void media.play().catch(() => {
      // Autoplay blocked or interrupted — the on-player control remains.
    });
  }, [autoPlay, media]);

  useEffect(() => {
    if (seekTo == null || !media || !isVideoMedia(media)) return;
    const apply = () => {
      if (Math.abs(media.currentTime - seekTo) <= 0.05) return;
      // HTMLMediaElement seek — useMedia() is the element, not React state.
      // oxlint-disable-next-line react/immutability
      media.currentTime = seekTo;
    };
    apply();
    media.addEventListener('loadedmetadata', apply);
    return () => media.removeEventListener('loadedmetadata', apply);
  }, [seekTo, media]);

  return (
    <NeutralVideoSkin className="shot-captions">
      <Video
        src={src || undefined}
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
      >
        {chaptersUrl && <track kind="chapters" src={chaptersUrl} default />}
        {subtitlesUrl && (
          <track
            key={subtitlesUrl}
            kind="captions"
            src={subtitlesUrl}
            srcLang="en"
            label="Dialogue"
            default
          />
        )}
      </Video>
      {media && isVideoMedia(media) ? <ShotCaptions media={media} /> : null}
      {!src && posterSrc && (
        <Poster.Root>
          <Poster.Image src={posterSrc} alt="Video thumbnail" />
        </Poster.Root>
      )}
    </NeutralVideoSkin>
  );
};

// Same layer as the sequence player. The skin's video does not paint its
// own cues, so this reads the showing captions track and draws the active one.
const captionsLayer: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  insetInline: 0,
  bottom: 0,
  display: 'flex',
  justifyContent: 'center',
  maxHeight: '70%',
  padding: '0 6%',
  pointerEvents: 'none',
  transform: 'translateY(var(--media-caption-track-y, 0px))',
};

const captionsText: CSSProperties = {
  maxWidth: '100%',
  overflow: 'hidden',
  padding: '0.15em 0.5em',
  borderRadius: '0.2em',
  background: 'rgba(0, 0, 0, 0.65)',
  color: '#fff',
  fontSize: 'clamp(14px, 3.2cqi, 30px)',
  lineHeight: 1.3,
  textAlign: 'center',
  whiteSpace: 'pre-line',
};

const ShotCaptions: React.FC<{ media: VideoMedia }> = ({ media }) => {
  const subscribe = useCallback(
    (notify: () => void) => {
      const tracks = media.textTracks;
      const onCue = () => notify();
      tracks.addEventListener('addtrack', onCue);
      tracks.addEventListener('change', onCue);
      media.addEventListener('timeupdate', onCue);
      media.addEventListener('seeked', onCue);
      media.addEventListener('loadedmetadata', onCue);
      return () => {
        tracks.removeEventListener('addtrack', onCue);
        tracks.removeEventListener('change', onCue);
        media.removeEventListener('timeupdate', onCue);
        media.removeEventListener('seeked', onCue);
        media.removeEventListener('loadedmetadata', onCue);
      };
    },
    [media]
  );
  const text = useSyncExternalStore(
    subscribe,
    () => showingCaptionText(media.textTracks, media.currentTime),
    () => null
  );
  if (!text) return null;
  return (
    <div data-part="shot-captions" style={captionsLayer}>
      <span style={captionsText}>{text}</span>
    </div>
  );
};

/**
 * Default export so `video-player.tsx` can reach this through `React.lazy`,
 * which requires a module whose default is the component.
 */
const VideoPlayerSurface: React.FC<VideoPlayerSurfaceProps> = (props) => (
  <VideoPlayer>
    <VideoPlayerInner {...props} />
  </VideoPlayer>
);

export default VideoPlayerSurface;
