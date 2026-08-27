import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  elementFullscreenSupported,
  isElementFullscreen,
  toggleElementFullscreen,
} from './fullscreen';

/**
 * Unit tests run in the `node` environment, so `document` and element
 * fullscreen APIs are stubbed here — the point is the branch order (document
 * fullscreen when enabled, video presentation when it is missing or rejects),
 * not DOM fidelity.
 */

type FakeVideo = {
  tagName: 'VIDEO';
  webkitSetPresentationMode?: (mode: string) => void;
  webkitEnterFullscreen?: () => void;
  webkitEndFullscreen?: () => void;
  webkitPresentationMode?: string;
  webkitDisplayingFullscreen?: boolean;
};

type FakeEl = {
  tagName: string;
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
  querySelector: (sel: string) => FakeVideo | null;
  contains: (node: unknown) => boolean;
  matches: (sel: string) => boolean;
};

function fakeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  return { tagName: 'VIDEO', ...overrides };
}

function fakeEl(overrides: Partial<FakeEl> = {}): HTMLElement {
  const el: FakeEl = {
    tagName: 'DIV',
    querySelector: () => null,
    contains: () => false,
    matches: () => false,
    ...overrides,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub; toggle only reads these members
  return el as unknown as HTMLElement;
}

type FakeDocument = {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void> | void;
};

function stubDocument(d: FakeDocument) {
  vi.stubGlobal('document', d);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toggleElementFullscreen', () => {
  it('uses requestFullscreen when document fullscreen is enabled', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const webkitRequestFullscreen = vi.fn();
    const webkitEnterFullscreen = vi.fn();
    stubDocument({ fullscreenEnabled: true, fullscreenElement: null });

    await toggleElementFullscreen(
      fakeEl({
        requestFullscreen,
        webkitRequestFullscreen,
        querySelector: () => fakeVideo({ webkitEnterFullscreen }),
      })
    );

    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitRequestFullscreen).not.toHaveBeenCalled();
    expect(webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it('uses webkitRequestFullscreen when the unprefixed method is missing', async () => {
    const webkitRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    const webkitEnterFullscreen = vi.fn();
    stubDocument({
      webkitFullscreenEnabled: true,
      webkitFullscreenElement: null,
    });

    await toggleElementFullscreen(
      fakeEl({
        webkitRequestFullscreen,
        querySelector: () => fakeVideo({ webkitEnterFullscreen }),
      })
    );

    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
    expect(webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it('skips a present-but-disabled requestFullscreen and uses the video', async () => {
    // iPhone: Element.requestFullscreen exists, document.fullscreenEnabled is
    // false, native video presentation is the only path that works.
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const webkitSetPresentationMode = vi.fn();
    stubDocument({ fullscreenEnabled: false, fullscreenElement: null });

    await toggleElementFullscreen(
      fakeEl({
        requestFullscreen,
        querySelector: () => fakeVideo({ webkitSetPresentationMode }),
      })
    );

    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(webkitSetPresentationMode).toHaveBeenCalledWith('fullscreen');
  });

  it('falls through to video when requestFullscreen rejects', async () => {
    const requestFullscreen = vi
      .fn()
      .mockRejectedValue(new TypeError('fullscreen not allowed'));
    const webkitSetPresentationMode = vi.fn();
    stubDocument({ fullscreenEnabled: true, fullscreenElement: null });

    await toggleElementFullscreen(
      fakeEl({
        requestFullscreen,
        querySelector: () => fakeVideo({ webkitSetPresentationMode }),
      })
    );

    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitSetPresentationMode).toHaveBeenCalledWith('fullscreen');
  });

  it('uses webkitEnterFullscreen when presentation-mode is missing', async () => {
    const webkitEnterFullscreen = vi.fn();
    stubDocument({ fullscreenEnabled: false, fullscreenElement: null });

    await toggleElementFullscreen(
      fakeEl({
        querySelector: () => fakeVideo({ webkitEnterFullscreen }),
      })
    );

    expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
  });

  it('exits this element, not some other fullscreen node', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const el = fakeEl({ requestFullscreen });
    stubDocument({
      fullscreenEnabled: true,
      fullscreenElement: { tagName: 'OTHER' },
      exitFullscreen,
    });

    await toggleElementFullscreen(el);

    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('exits via exitFullscreen when this element is fullscreen', async () => {
    const requestFullscreen = vi.fn();
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const el = fakeEl({ requestFullscreen });
    stubDocument({
      fullscreenEnabled: true,
      fullscreenElement: el,
      exitFullscreen,
    });

    await toggleElementFullscreen(el);

    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('exits native video presentation without calling document.exitFullscreen', async () => {
    const exitFullscreen = vi.fn();
    const webkitSetPresentationMode = vi.fn();
    stubDocument({
      fullscreenEnabled: false,
      fullscreenElement: null,
      exitFullscreen,
    });

    await toggleElementFullscreen(
      fakeEl({
        querySelector: () =>
          fakeVideo({
            webkitPresentationMode: 'fullscreen',
            webkitSetPresentationMode,
          }),
      })
    );

    expect(webkitSetPresentationMode).toHaveBeenCalledWith('inline');
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it('no-ops when nothing is available', async () => {
    stubDocument({ fullscreenEnabled: false, fullscreenElement: null });
    await expect(toggleElementFullscreen(fakeEl())).resolves.toBeUndefined();
  });

  it('no-ops when el is null', async () => {
    stubDocument({ fullscreenEnabled: true });
    await expect(toggleElementFullscreen(null)).resolves.toBeUndefined();
  });
});

describe('isElementFullscreen', () => {
  it('is true when the container is the fullscreen element', () => {
    const el = fakeEl();
    stubDocument({ fullscreenElement: el });
    expect(isElementFullscreen(el)).toBe(true);
  });

  it('is true when a descendant is the fullscreen element', () => {
    const inner = { tagName: 'VIDEO' };
    const el = fakeEl({ contains: (node) => node === inner });
    stubDocument({ fullscreenElement: inner });
    expect(isElementFullscreen(el)).toBe(true);
  });

  it('is true when the video reports native fullscreen', () => {
    stubDocument({ fullscreenElement: null });
    const el = fakeEl({
      querySelector: () => fakeVideo({ webkitPresentationMode: 'fullscreen' }),
    });
    expect(isElementFullscreen(el)).toBe(true);
  });

  it('is false when something else is fullscreen', () => {
    stubDocument({ fullscreenElement: { tagName: 'OTHER' } });
    expect(isElementFullscreen(fakeEl())).toBe(false);
  });
});

describe('elementFullscreenSupported', () => {
  it('is true when document fullscreen is enabled', () => {
    stubDocument({ fullscreenEnabled: true });
    expect(elementFullscreenSupported(null)).toBe(true);
  });

  it('is true when the container has a video presentation fallback', () => {
    stubDocument({ fullscreenEnabled: false });
    expect(
      elementFullscreenSupported(
        fakeEl({
          querySelector: () =>
            fakeVideo({ webkitSetPresentationMode: vi.fn() }),
        })
      )
    ).toBe(true);
  });

  it('is false when neither document fullscreen nor a video fallback exists', () => {
    stubDocument({ fullscreenEnabled: false });
    expect(elementFullscreenSupported(fakeEl())).toBe(false);
  });
});
