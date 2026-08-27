import { useCallback, useEffect, useState, type RefObject } from 'react';

// lib.dom types the Fullscreen API as always-present, but Safari (macOS < 16.4
// and every iOS version) ships it behind webkit prefixes, and iPhone Safari
// before 16.4 has no element fullscreen at all — only the native video
// fullscreen via `webkitEnterFullscreen()` on the <video> element itself.
// These views re-type the members as optional so the runtime checks below are
// honest instead of asserted away.
type ElementFullscreenApi = {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type DocumentFullscreenApi = {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type VideoFullscreenApi = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

const fullscreenElement = (): Element | null => {
  const doc: DocumentFullscreenApi = document;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
};

/**
 * Element fullscreen for a player container. `toggle` enters/exits fullscreen
 * on the ref'd element; where element fullscreen is unavailable (iPhone Safari
 * < 16.4) it falls back to native video fullscreen on the first <video> inside
 * the container.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>): {
  isFullscreen: boolean;
  toggle: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => {
      setIsFullscreen(
        ref.current != null && fullscreenElement() === ref.current
      );
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [ref]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (fullscreenElement()) {
      const doc: DocumentFullscreenApi = document;
      if (doc.exitFullscreen) void doc.exitFullscreen();
      else void doc.webkitExitFullscreen?.();
      return;
    }
    const api: ElementFullscreenApi = el;
    if (api.requestFullscreen) {
      void api.requestFullscreen();
      return;
    }
    if (api.webkitRequestFullscreen) {
      void api.webkitRequestFullscreen();
      return;
    }
    const video: VideoFullscreenApi | null = el.querySelector('video');
    video?.webkitEnterFullscreen?.();
  }, [ref]);

  return { isFullscreen, toggle };
}
