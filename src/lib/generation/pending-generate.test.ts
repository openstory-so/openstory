import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('pending generate/enhance intent', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { localStorage: localStorageMock });
    vi.stubGlobal('localStorage', localStorageMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('remembers Generate and Enhance, consumes once, expires, reads legacy timestamps', async () => {
    const { markPendingIntent, hasPendingGenerate, takePendingIntent } =
      await import('./pending-generate');

    expect(hasPendingGenerate()).toBe(false);
    markPendingIntent('generate');
    expect(takePendingIntent()).toBe('generate');
    expect(takePendingIntent()).toBeNull();

    markPendingIntent('enhance');
    expect(hasPendingGenerate()).toBe(true);
    expect(takePendingIntent()).toBe('enhance');

    localStorage.setItem('openstory:pending-generate', String(Date.now()));
    expect(takePendingIntent()).toBe('generate');

    markPendingIntent('enhance');
    vi.setSystemTime(new Date('2026-08-25T12:11:00Z'));
    expect(takePendingIntent()).toBeNull();
  });
});
