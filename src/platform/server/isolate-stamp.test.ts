import { describe, expect, it, vi } from 'vitest';

describe('getIsolateId', () => {
  it('mints the id on the first call, not when the module loads', async () => {
    vi.resetModules();
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    const loaded = await import('./isolate-stamp');

    expect(randomUUID).not.toHaveBeenCalled();
    const first = loaded.getIsolateId();
    expect(loaded.getIsolateId()).toBe(first);
    expect(randomUUID).toHaveBeenCalledOnce();
    randomUUID.mockRestore();
  });
});
