import {
  elementFullscreenSupported,
  isElementFullscreen,
  toggleElementFullscreen,
  videoFor,
} from '@/lib/utils/fullscreen';
import { useCallback, useEffect, useState, type RefObject } from 'react';

const DOCUMENT_FS_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
] as const;

const VIDEO_FS_EVENTS = [
  'webkitbeginfullscreen',
  'webkitendfullscreen',
  'webkitpresentationmodechanged',
] as const;

/**
 * Fullscreen toggle for a player container. `supported` is false on iPhone
 * until a `<video>` exists (element fullscreen is unavailable there).
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>): {
  isFullscreen: boolean;
  supported: boolean;
  toggle: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const sync = () => {
      const el = ref.current;
      setIsFullscreen(isElementFullscreen(el));
      setSupported(elementFullscreenSupported(el));
    };

    sync();

    for (const event of DOCUMENT_FS_EVENTS) {
      document.addEventListener(event, sync);
    }

    let video: HTMLElement | null = null;
    const unbindVideo = () => {
      if (!video) return;
      for (const event of VIDEO_FS_EVENTS) {
        video.removeEventListener(event, sync);
      }
      video = null;
    };
    const bindVideo = () => {
      unbindVideo();
      const el = ref.current;
      video = el ? videoFor(el) : null;
      if (!video) return;
      for (const event of VIDEO_FS_EVENTS) {
        video.addEventListener(event, sync);
      }
    };
    bindVideo();

    const el = ref.current;
    const observer =
      el && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            bindVideo();
            sync();
          })
        : null;
    if (el && observer) {
      observer.observe(el, { childList: true, subtree: true });
    }

    return () => {
      for (const event of DOCUMENT_FS_EVENTS) {
        document.removeEventListener(event, sync);
      }
      unbindVideo();
      observer?.disconnect();
    };
  }, [ref]);

  const toggle = useCallback(() => {
    void toggleElementFullscreen(ref.current);
  }, [ref]);

  return { isFullscreen, supported, toggle };
}
