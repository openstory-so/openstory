import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STUDIO_COMPOSER_MAX_FRACTION,
  MAX_STUDIO_COMPOSER_MAX_FRACTION,
  MIN_STUDIO_COMPOSER_MAX_FRACTION,
  MIN_STUDIO_COMPOSER_PX,
  MIN_STUDIO_GALLERY_PX,
  STUDIO_COMPOSER_MAX_HEIGHT_KEY,
  clampStudioComposerMaxFraction,
  composerMaxFractionFromPointer,
  loadStudioComposerMaxFraction,
  parseStudioComposerMaxFraction,
  saveStudioComposerMaxFraction,
  studioComposerMaxHeightCss,
} from './composer-max-height';

const mem = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

describe('studio composer max height', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { localStorage: localStorageMock });
    vi.stubGlobal('localStorage', localStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clamps to the allowed band and substitutes the default for garbage', () => {
    expect(clampStudioComposerMaxFraction(0.4)).toBe(0.4);
    expect(clampStudioComposerMaxFraction(0)).toBe(
      MIN_STUDIO_COMPOSER_MAX_FRACTION
    );
    expect(clampStudioComposerMaxFraction(1)).toBe(
      MAX_STUDIO_COMPOSER_MAX_FRACTION
    );
    expect(clampStudioComposerMaxFraction(Number.NaN)).toBe(
      DEFAULT_STUDIO_COMPOSER_MAX_FRACTION
    );
  });

  it('parses stored strings the same way', () => {
    expect(parseStudioComposerMaxFraction(null)).toBe(
      DEFAULT_STUDIO_COMPOSER_MAX_FRACTION
    );
    expect(parseStudioComposerMaxFraction('0.55')).toBe(0.55);
    expect(parseStudioComposerMaxFraction('nope')).toBe(
      DEFAULT_STUDIO_COMPOSER_MAX_FRACTION
    );
  });

  it('maps a pointer on the pane top edge to the composer fraction', () => {
    expect(
      composerMaxFractionFromPointer({
        columnHeight: 1000,
        columnBottom: 1000,
        clientY: 600,
      })
    ).toBe(0.4);
    expect(
      composerMaxFractionFromPointer({
        columnHeight: 1000,
        columnBottom: 1000,
        clientY: 0,
      })
    ).toBe(MAX_STUDIO_COMPOSER_MAX_FRACTION);
    expect(
      composerMaxFractionFromPointer({
        columnHeight: 1000,
        columnBottom: 1000,
        clientY: 950,
      })
    ).toBe(MIN_STUDIO_COMPOSER_MAX_FRACTION);
  });

  it('round-trips through localStorage', () => {
    expect(loadStudioComposerMaxFraction()).toBe(
      DEFAULT_STUDIO_COMPOSER_MAX_FRACTION
    );
    expect(saveStudioComposerMaxFraction(0.62)).toBe(0.62);
    expect(mem.get(STUDIO_COMPOSER_MAX_HEIGHT_KEY)).toBe('0.62');
    expect(loadStudioComposerMaxFraction()).toBe(0.62);
  });

  it('emits a max-height that floors the pane and leaves room for the gallery', () => {
    expect(studioComposerMaxHeightCss(0.4)).toBe(
      `min(max(${MIN_STUDIO_COMPOSER_PX}px, 40%), calc(100% - ${MIN_STUDIO_GALLERY_PX}px))`
    );
  });
});
