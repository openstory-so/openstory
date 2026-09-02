import { beforeEach, describe, expect, it, vi } from 'vitest';

type PreloadHandler = (event: {
  payload: unknown;
  preventDefault: () => void;
}) => void;

const store = new Map<string, string>();
const reload = vi.fn();
let handler: PreloadHandler | undefined;

/** Dispatch what Vite's preload helper dispatches. */
function firePreloadError() {
  const preventDefault = vi.fn();
  handler?.({ payload: new Error('boom'), preventDefault });
  return preventDefault;
}

beforeEach(async () => {
  store.clear();
  reload.mockClear();
  handler = undefined;
  vi.stubGlobal('window', {
    addEventListener: (_type: string, fn: PreloadHandler) => {
      handler = fn;
    },
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal('location', { reload });
  vi.resetModules();
  const { installChunkReload } = await import('./chunk-reload');
  installChunkReload();
});

describe('installChunkReload', () => {
  it('reloads on the first preload error and suppresses the throw', () => {
    const preventDefault = firePreloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('does not reload twice for the same page load', () => {
    firePreloadError();
    const preventDefault = firePreloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    // Second time we let the error through to the boundary.
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('reloads again once the retry window has passed', () => {
    firePreloadError();
    store.set('os:chunk-reloaded-at', String(Date.now() - 60_000));
    firePreloadError();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload without sessionStorage (no loop guard)', () => {
    vi.stubGlobal('sessionStorage', undefined);
    const preventDefault = firePreloadError();
    expect(reload).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
