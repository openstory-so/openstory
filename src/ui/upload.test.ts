import { describe, expect, it } from 'vitest';
import { getFileKey, snapshotFile } from './upload';

describe('snapshotFile', () => {
  it('copies bytes into a new File with a stable key', async () => {
    const src = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', {
      type: 'image/png',
      lastModified: 1,
    });
    const copy = await snapshotFile(src);
    expect(copy).not.toBe(src);
    expect(new Uint8Array(await copy.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
    expect(copy.name).toBe('image.png');
    expect(copy.type).toBe('image/png');
    expect(getFileKey(copy)).toBe(getFileKey(src));
  });
});
