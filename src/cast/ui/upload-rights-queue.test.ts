import { describe, expect, it, vi } from 'vitest';
import { createUploadRightsQueue } from './upload-rights-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('upload rights dialog queue (#2236)', () => {
  it('keeps concurrent uploads waiting for their own confirmation', async () => {
    const queue = createUploadRightsQueue();
    const first = deferred();
    const second = deferred();
    const showFirst = vi.fn(() => first.promise);
    const showSecond = vi.fn(() => second.promise);
    const firstUpload = queue(showFirst);
    const secondUpload = queue(showSecond);
    await Promise.resolve();
    expect(showFirst).toHaveBeenCalledOnce();
    expect(showSecond).not.toHaveBeenCalled();
    first.resolve();
    await firstUpload;
    await Promise.resolve();
    expect(showSecond).toHaveBeenCalledOnce();
    second.resolve();
    await expect(secondUpload).resolves.toBeUndefined();
  });

  it('lets later uploads continue after an earlier sign-off is declined', async () => {
    const queue = createUploadRightsQueue();
    const declined = queue(() => Promise.reject(new Error('Declined')));
    const next = vi.fn(() => Promise.resolve());
    const nextUpload = queue(next);
    await expect(declined).rejects.toThrow('Declined');
    await expect(nextUpload).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
