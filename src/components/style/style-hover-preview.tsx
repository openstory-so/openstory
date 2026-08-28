import { AppImage } from '@/components/ui/app-image';
import { optimizedVideoUrl } from '@/lib/media/cloudflare-video';
import { styleHoverVideoUrl } from '@/lib/style/style-assets';
import { cn } from '@/lib/utils';
import type { Style } from '@/types/database';
import type { FC } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStyleGradient } from './style-gradient';
import { getConfigColorPalette } from '@/lib/style/style-config';

type StyleHoverPreviewProps = {
  style: Style;
  /** Disable the hover clip (e.g. on a touch surface). Defaults to enabled. */
  hoverVideo?: boolean;
  className?: string;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * A square style thumbnail that plays the style's looping `hover.mp4` clip
 * while pointer-hovered, falling back to the static preview image and then the
 * palette gradient. The video is mounted lazily on first hover (so a grid of
 * 80 styles doesn't fetch 80 clips up front) and honours `prefers-reduced-motion`.
 *
 * Self-contained: it manages its own hover state on its root element, so the
 * parent only needs to render it inside whatever clickable card it wants.
 */
export const StyleHoverPreview: FC<StyleHoverPreviewProps> = ({
  style,
  hoverVideo = true,
  className,
}) => {
  const [imgError, setImgError] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Mount the <video> only once hovered for the first time (lazy load), then
  // keep it mounted so re-hovers replay instantly.
  const [activated, setActivated] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Route the master hover clip through Cloudflare Media Transformations so a
  // grid of tiles fetches a small, tile-sized re-encode rather than the full
  // master mp4 (degrades to the original URL off-zone, e.g. local dev).
  const rawHoverUrl = hoverVideo ? styleHoverVideoUrl(style) : null;
  const hoverUrl = rawHoverUrl ? optimizedVideoUrl(rawHoverUrl, 400) : null;

  const handleEnter = useCallback(() => {
    if (!hoverUrl || prefersReducedMotion()) return;
    setActivated(true);
    setHovered(true);
  }, [hoverUrl]);

  const handleLeave = useCallback(() => {
    setHovered(false);
  }, []);

  // Drive play/pause off hover state. Runs after the video mounts (activated),
  // so the very first hover plays without a ref race.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (hovered) {
      void video.play().catch(() => {
        // Autoplay can reject (e.g. not yet loaded); the loadeddata handler
        // retries, and the static image stays visible meanwhile.
      });
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }, [hovered, activated]);

  const handleVideoLoaded = useCallback(() => {
    setVideoLoaded(true);
    if (hovered) void videoRef.current?.play().catch(() => {});
  }, [hovered]);

  const showImage = style.previewUrl && !imgError;

  return (
    <div
      className={cn(
        'relative aspect-square overflow-hidden bg-muted',
        className
      )}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {showImage ? (
        <AppImage
          src={style.previewUrl ?? ''}
          alt={`${style.name} style preview`}
          layout="fullWidth"
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <div
          className="h-full w-full"
          style={{
            background: getStyleGradient(getConfigColorPalette(style.config)),
          }}
        />
      )}

      {activated && hoverUrl && (
        <video
          ref={videoRef}
          src={hoverUrl}
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-300',
            hovered && videoLoaded ? 'opacity-100' : 'opacity-0'
          )}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          onLoadedData={handleVideoLoaded}
        />
      )}
    </div>
  );
};
