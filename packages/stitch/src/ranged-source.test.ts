import { describe, expect, it } from 'vitest';
import { createRangedReader } from './ranged-source.js';

const KB = 1024;
const MB = 1024 * KB;

/** Byte `i` of the fake file. */
const byteAt = (i: number) => i % 251;
function bytes(start: number, end: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(end - start);
  for (let k = 0; k < out.length; k++) out[k] = byteAt(start + k);
  return out;
}
const isRange = (got: Uint8Array, start: number) =>
  got.every((value, k) => value === byteAt(start + k));

function fakeServer(size: number) {
  const ranges: string[] = [];
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range') ?? '';
    ranges.push(range);
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
    const start = Number(a);
    const end = Math.min(Number(b), size - 1);
    return new Response(bytes(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  };
  const sizes = () =>
    ranges.map((r) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(r) ?? [];
      return (Number(b) - Number(a) + 1) / KB;
    });
  return { ranges, sizes, fetchFn };
}

describe('createRangedReader', () => {
  it('reads a header in one 64 KiB request', async () => {
    const { ranges, fetchFn } = fakeServer(5 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    expect(await reader.getSize()).toBe(5 * MB);
    // ftyp, moov and friends: many small reads inside the first block.
    const headerReads: [number, number][] = [
      [0, 8],
      [8, 40],
      [40, 13_000],
      [13_000, 18_600],
    ];
    for (const [start, end] of headerReads) {
      expect(isRange(await reader.read(start, end), start)).toBe(true);
    }
    expect(ranges).toEqual(['bytes=0-65535']);
  });

  it('grows the read-ahead while a clip plays through, capped at 2 MiB', async () => {
    const { sizes, fetchFn } = fakeServer(5 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    await reader.getSize();
    for (let pos = 64 * KB; pos < 4 * MB; pos += 20 * KB) {
      expect(isRange(await reader.read(pos, pos + 20 * KB), pos)).toBe(true);
    }
    expect(sizes().slice(0, 5)).toEqual([64, 128, 256, 512, 1024]);
    expect(Math.max(...sizes())).toBe(2048);
  });

  it('starts small again after a seek', async () => {
    const { ranges, fetchFn } = fakeServer(5 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    await reader.getSize();
    await reader.read(64 * KB, 70 * KB);
    await reader.read(3000 * KB, 3001 * KB);
    // The block holding 3000 KiB, alone.
    const block = Math.floor((3000 * KB) / (64 * KB)) * 64 * KB;
    expect(ranges.at(-1)).toBe(`bytes=${block}-${block + 64 * KB - 1}`);
  });

  it('fetches the header again once playing has pushed it out', async () => {
    const size = 24 * MB;
    const { ranges, fetchFn } = fakeServer(size);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    await reader.getSize();
    // Play past the 16 MiB cache, so block 0 is the oldest and goes, then
    // read the header again, as a new sink does.
    for (let pos = 64 * KB; pos < size; pos += 256 * KB) {
      await reader.read(pos, Math.min(pos + 256 * KB, size));
    }
    const before = ranges.length;
    expect(isRange(await reader.read(0, 40), 0)).toBe(true);
    expect(ranges.length).toBe(before + 1);
  });
});

function throttledServer(size: number) {
  const server = fakeServer(size);
  const gates: Array<() => void> = [];
  const fetchFn: typeof server.fetchFn = async (url, init) => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return server.fetchFn(url, init);
  };
  const release = () => gates.splice(0).forEach((open) => open());
  return { ...server, fetchFn, release };
}

describe('createRangedReader read-ahead (#2124)', () => {
  it('banks a window in 2 MiB requests and never fetches a block twice', async () => {
    const { ranges, sizes, fetchFn, release } = throttledServer(24 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    const sized = reader.getSize();
    release();
    expect(await sized).toBe(24 * MB);
    const banked = reader.ensureRange(0, 6 * MB);
    // A read inside the window while it is in flight waits on it.
    const read = reader.read(100 * KB, 120 * KB);
    const pending = { count: 1 };
    void banked.then(() => {
      pending.count = 0;
    });
    while (pending.count > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
    }
    expect(isRange(await read, 100 * KB)).toBe(true);
    expect(sizes()).toEqual([64, 2048 - 64, 2048, 2048]);
    expect(ranges.length).toBe(4);
    expect(reader.cachedFrom(0)).toBe(6 * MB);
    expect(reader.cachedFrom(5 * MB)).toBe(1 * MB);
    expect(reader.cachedFrom(6 * MB)).toBe(0);
  });

  it('reports the end of the file and the 8 MiB cap as fully banked', async () => {
    const size = 24 * MB;
    const { sizes, fetchFn } = fakeServer(size);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    await reader.getSize();
    await reader.ensureRange(size - 100 * KB, size + 5 * MB);
    expect(reader.cachedFrom(size - 100 * KB)).toBe(Infinity);
    await reader.ensureRange(4 * MB, 20 * MB);
    expect(Math.max(...sizes())).toBe(2048);
    expect(
      sizes()
        .slice(2)
        .reduce((a, b) => a + b, 0)
    ).toBe(8 * 1024);
    expect(reader.cachedFrom(4 * MB)).toBe(Infinity);
    expect(reader.cachedFrom(12 * MB)).toBe(0);
  });
});
