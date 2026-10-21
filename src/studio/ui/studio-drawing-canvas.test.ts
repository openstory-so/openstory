import { describe, expect, it } from 'vitest';
import {
  appendUndoSnapshot,
  canvasToPngFile,
  isBlankSnapshot,
} from './studio-drawing-canvas';

function makeImageData(fill = 255): ImageData {
  return {
    data: new Uint8ClampedArray(16).fill(fill),
    width: 2,
    height: 2,
    colorSpace: 'srgb',
  };
}

describe('canvasToPngFile', () => {
  it('exports a PNG file with the expected name', async () => {
    const types: (string | null | undefined)[] = [];
    const canvas = {
      toBlob(callback: BlobCallback, type?: string | null) {
        types.push(type);
        callback(new Blob(['png'], { type: 'image/png' }));
      },
    };

    const file = await canvasToPngFile(canvas);

    expect(types).toEqual(['image/png']);
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/png');
    expect(file.name).toMatch(/^reference-drawing-\d+\.png$/);
  });

  it('throws when the canvas export fails', async () => {
    const canvas = {
      toBlob(callback: BlobCallback) {
        callback(null);
      },
    };

    await expect(canvasToPngFile(canvas)).rejects.toThrow(
      'Failed to export drawing'
    );
  });
});

describe('isBlankSnapshot', () => {
  it('detects an all-white snapshot as blank', () => {
    expect(isBlankSnapshot(makeImageData())).toBe(true);
  });

  it('detects a non-white pixel as ink', () => {
    const snapshot = makeImageData();
    snapshot.data[0] = 0;
    expect(isBlankSnapshot(snapshot)).toBe(false);
  });
});

describe('appendUndoSnapshot', () => {
  it('drops nothing below the cap', () => {
    const snapshots = Array.from({ length: 24 }, (_, index) =>
      makeImageData(index)
    );
    const next = appendUndoSnapshot(snapshots, makeImageData(24));

    expect(next).toHaveLength(25);
    expect(next[0]?.data[0]).toBe(0);
  });

  it('keeps only the latest 25 snapshots', () => {
    const snapshots = Array.from({ length: 25 }, (_, index) =>
      makeImageData(index)
    );
    const next = appendUndoSnapshot(snapshots, makeImageData(25));

    expect(next).toHaveLength(25);
    expect(next[0]?.data[0]).toBe(1);
    expect(next.at(-1)?.data[0]).toBe(25);
  });
});
