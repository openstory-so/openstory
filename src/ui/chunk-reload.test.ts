import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STALE_SERVER_FN_HEADER } from '@/platform/stale-server-fn';

type PreloadHandler = (event: {
  payload: unknown;
  preventDefault: () => void;
}) => void;

const store = new Map<string, string>();
const reload = vi.fn();
const origFetch = vi.fn();
let handler: PreloadHandler | undefined;
let isReloadPending: () => boolean;
let win: {
  addEventListener: (type: string, fn: PreloadHandler) => void;
  fetch: typeof fetch;
};

/** Dispatch what Vite's preload helper dispatches. */
function firePreloadError() {
  const preventDefault = vi.fn();
  handler?.({ payload: new Error('boom'), preventDefault });
  return preventDefault;
}

beforeEach(async () => {
  store.clear();
  reload.mockClear();
  origFetch.mockReset();
  handler = undefined;
  win = {
    addEventListener: (_type: string, fn: PreloadHandler) => {
      handler = fn;
    },
    fetch: origFetch,
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal('location', { reload });
  vi.resetModules();
  const mod = await import('./chunk-reload');
  isReloadPending = mod.isReloadPending;
  mod.installChunkReload();
});

describe('installChunkReload', () => {
  it('reloads on the first preload error and suppresses the throw', () => {
    expect(isReloadPending()).toBe(false);
    const preventDefault = firePreloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    // The page runs on for a beat; the boundary uses this to stay quiet.
    expect(isReloadPending()).toBe(true);
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
    expect(isReloadPending()).toBe(false);
  });

  it('reloads on a marked stale server-fn response and does not return it', async () => {
    origFetch.mockResolvedValue(
      new Response('stale server function', {
        status: 404,
        headers: { [STALE_SERVER_FN_HEADER]: '1' },
      })
    );
    const pending = win.fetch('/_serverFn/old-id');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(isReloadPending()).toBe(true);
    const raced = await Promise.race([
      pending.then(() => 'resolved'),
      Promise.resolve('hung'),
    ]);
    expect(raced).toBe('hung');
  });

  it('passes through ordinary fetch responses', async () => {
    const ok = new Response('ok', { status: 200 });
    origFetch.mockResolvedValue(ok);
    await expect(win.fetch('/_serverFn/current')).resolves.toBe(ok);
    expect(reload).not.toHaveBeenCalled();
  });
});
