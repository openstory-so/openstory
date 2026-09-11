import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// R2 as an in-memory map, with the same ranged-read contract as the binding.
const objects = new Map<string, Uint8Array>();
const readStorageObject = vi.fn(
  async (key: string, range?: { offset: number; length: number }) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    const slice = range
      ? bytes.slice(range.offset, range.offset + range.length)
      : bytes;
    return { bytes: new Uint8Array(slice), contentType: '' };
  }
);
vi.doMock('#storage', () => ({
  readStorageObject,
  storageObjectSize: async (key: string) => objects.get(key)?.length ?? null,
}));

const { measureStoredMediaDuration } = await import('./media-duration');

/** A mono 16-bit PCM WAV of `seconds` of silence. */
function wav(seconds: number, sampleRate = 8000): Uint8Array {
  const dataSize = seconds * sampleRate * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

describe('measureStoredMediaDuration', () => {
  it('reads an MP4 clip’s length from its container', async () => {
    objects.set(
      'elements/t/clip.mp4',
      new Uint8Array(
        readFileSync(
          resolve(__dirname, '../../../../e2e/fixtures/test-video.mp4')
        )
      )
    );
    // ffprobe: 0.500000
    expect(await measureStoredMediaDuration('elements/t/clip.mp4')).toBeCloseTo(
      0.5,
      2
    );
  });

  it('reads an audio file’s length', async () => {
    objects.set('elements/t/line.wav', wav(3));
    expect(await measureStoredMediaDuration('elements/t/line.wav')).toBeCloseTo(
      3,
      2
    );
  });

  it('reads ranges, not the whole object', async () => {
    const big = wav(20);
    objects.set('elements/t/long.wav', big);
    readStorageObject.mockClear();
    await measureStoredMediaDuration('elements/t/long.wav');
    const read = readStorageObject.mock.calls.reduce(
      (sum, [, range]) => sum + (range?.length ?? big.length),
      0
    );
    expect(read).toBeLessThan(big.length);
  });

  it('answers null for a missing object or a file that is not media', async () => {
    expect(await measureStoredMediaDuration('elements/t/nope.mp4')).toBeNull();
    objects.set('elements/t/notes.mp4', new TextEncoder().encode('not media'));
    expect(await measureStoredMediaDuration('elements/t/notes.mp4')).toBeNull();
  });
});
