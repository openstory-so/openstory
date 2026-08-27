/**
 * Element fullscreen for a player container, with iPhone video fallback.
 *
 * lib.dom types `requestFullscreen` as always-present. Safari < 16.4 (macOS /
 * iPadOS) only shipped webkit* members. iPhone Safari still has no element
 * fullscreen — `requestFullscreen` exists on a div and rejects — so the real
 * path there is native `<video>` presentation (`webkitSetPresentationMode` /
 * `webkitEnterFullscreen`). These views keep the members optional so the
 * feature-detects are real narrowing.
 */

type ElementFullscreenApi = {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type DocumentFullscreenApi = {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type VideoHost = {
  tagName: string;
  webkitEnterFullscreen?: () => void;
  webkitEndFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSetPresentationMode?: (
    mode: 'fullscreen' | 'inline' | 'picture-in-picture'
  ) => void;
  webkitPresentationMode?: 'fullscreen' | 'inline' | 'picture-in-picture';
};

const videoHost = (el: HTMLElement | null): VideoHost | null => el;

const doc = (): DocumentFullscreenApi => document;

const getFullscreenElement = (): Element | null => {
  if (typeof document === 'undefined') return null;
  const d = doc();
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
};

const documentFullscreenEnabled = (): boolean => {
  if (typeof document === 'undefined') return false;
  const d = doc();
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
};

export const videoFor = (el: HTMLElement): HTMLElement | null => {
  if (el.tagName === 'VIDEO') return el;
  return el.querySelector('video');
};

const videoIsNativeFullscreen = (el: HTMLElement | null): boolean => {
  const video = videoHost(el);
  return (
    video != null &&
    (video.webkitPresentationMode === 'fullscreen' ||
      video.webkitDisplayingFullscreen === true)
  );
};

export const isElementFullscreen = (el: HTMLElement | null): boolean => {
  if (!el) return false;
  const fs = getFullscreenElement();
  if (fs && (fs === el || el.contains(fs))) return true;
  try {
    if (el.matches(':fullscreen')) return true;
  } catch {
    // `:fullscreen` throws in some engines when the selector is unknown.
  }
  return videoIsNativeFullscreen(videoFor(el));
};

export const elementFullscreenSupported = (el: HTMLElement | null): boolean => {
  if (documentFullscreenEnabled()) return true;
  if (!el) return false;
  const video = videoHost(videoFor(el));
  return Boolean(
    video?.webkitSetPresentationMode || video?.webkitEnterFullscreen
  );
};

const enterVideoFullscreen = (el: HTMLElement): void => {
  const video = videoHost(el);
  if (!video) return;
  if (video.webkitSetPresentationMode) {
    video.webkitSetPresentationMode('fullscreen');
    return;
  }
  video.webkitEnterFullscreen?.();
};

const exitVideoFullscreen = (el: HTMLElement): boolean => {
  const video = videoHost(el);
  if (!video) return false;
  if (
    video.webkitPresentationMode === 'fullscreen' &&
    video.webkitSetPresentationMode
  ) {
    video.webkitSetPresentationMode('inline');
    return true;
  }
  if (video.webkitDisplayingFullscreen && video.webkitEndFullscreen) {
    video.webkitEndFullscreen();
    return true;
  }
  return false;
};

const enterElementFullscreen = async (el: HTMLElement): Promise<boolean> => {
  if (!documentFullscreenEnabled()) return false;
  const api: ElementFullscreenApi = el;
  try {
    if (api.requestFullscreen) {
      await api.requestFullscreen();
      return true;
    }
    if (api.webkitRequestFullscreen) {
      await Promise.resolve(api.webkitRequestFullscreen());
      return true;
    }
  } catch {
    // iPhone: the method exists on a div and rejects. Fall through to video.
  }
  return false;
};

const exitDocumentFullscreen = async (): Promise<void> => {
  const d = doc();
  try {
    if (d.exitFullscreen) {
      await d.exitFullscreen();
      return;
    }
    await Promise.resolve(d.webkitExitFullscreen?.());
  } catch {
    // Already exited, or the UA refused. The next event will sync UI.
  }
};

/**
 * Toggle fullscreen on `el`. No-ops when `el` is null or nothing can succeed.
 * Never throws — a fullscreen button must not take the click handler down.
 */
export const toggleElementFullscreen = async (
  el: HTMLElement | null
): Promise<void> => {
  if (!el || typeof document === 'undefined') return;

  if (isElementFullscreen(el)) {
    const video = videoFor(el);
    if (video && exitVideoFullscreen(video)) return;
    await exitDocumentFullscreen();
    return;
  }

  if (await enterElementFullscreen(el)) return;

  const video = videoFor(el);
  if (!video) return;
  try {
    enterVideoFullscreen(video);
  } catch {
    // INVALID_STATE_ERR if metadata is not loaded yet.
  }
};
