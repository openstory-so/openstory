import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadOnceForChunkError } from './chunk-reload';

const store = new Map<string, string>();
const reload = vi.fn();

beforeEach(() => {
  store.clear();
  reload.mockClear();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal('location', { reload });
});

describe('reloadOnceForChunkError', () => {
  it('reloads once for a stale chunk, not twice', () => {
    const error = new Error(
      'Failed to fetch dynamically imported module: /assets/route-a1b2.js'
    );
    expect(reloadOnceForChunkError(error)).toBe(true);
    expect(reloadOnceForChunkError(error)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the cooldown has passed', () => {
    const error = new Error('Importing a module script failed.');
    expect(reloadOnceForChunkError(error)).toBe(true);
    store.set('os:chunk-reloaded-at', String(Date.now() - 60_000));
    expect(reloadOnceForChunkError(error)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('ignores unrelated errors', () => {
    expect(reloadOnceForChunkError(new Error('insertBefore'))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload without sessionStorage (no loop guard)', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(
      reloadOnceForChunkError(
        new Error('Failed to fetch dynamically imported module')
      )
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
