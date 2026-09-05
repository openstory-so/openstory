import { beforeEach, describe, expect, it, vi } from 'vitest';

type PreloadHandler = (event: {
  payload: unknown;
  preventDefault: () => void;
}) => void;

const store = new Map<string, string>();
const reload = vi.fn();
let handler: PreloadHandler | undefined;
let reloadOnStaleRouteChunk: (error: unknown) => void;

/** A route chunk that imported but resolved to the wrong shape. */
function staleRouteChunkError() {
  const error = new TypeError(
    "Cannot read properties of undefined (reading 'component')"
  );
  error.stack =
    "TypeError: Cannot read properties of undefined (reading 'component')\n" +
    '    at https://openstory.so/assets/lazyRouteComponent-7ROn1-wk.js:1:1234\n' +
    '    at async Xe.load (https://openstory.so/assets/breadcrumbs-c67hzjKa.js:1:17940)';
  return error;
}

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
  const mod = await import('./chunk-reload');
  reloadOnStaleRouteChunk = mod.reloadOnStaleRouteChunk;
  mod.installChunkReload();
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

describe('reloadOnStaleRouteChunk', () => {
  it('reloads when the stack originates in the lazyRouteComponent chunk', () => {
    reloadOnStaleRouteChunk(staleRouteChunkError());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores any other error', () => {
    reloadOnStaleRouteChunk(new TypeError('x is not a function'));
    reloadOnStaleRouteChunk('not an error at all');
    expect(reload).not.toHaveBeenCalled();
  });

  it('shares the one reload with the preload-error path', () => {
    firePreloadError();
    reloadOnStaleRouteChunk(staleRouteChunkError());
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
