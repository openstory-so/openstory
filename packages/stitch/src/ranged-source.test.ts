import { describe, expect, it, vi } from 'vitest';
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

describe('createRangedReader whole-file download (#2124)', () => {
  it('streams the file in one request and never fetches a block twice', async () => {
    const { sizes, fetchFn, release } = throttledServer(6 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    const sized = reader.getSize();
    release();
    expect(await sized).toBe(6 * MB);
    expect(reader.isComplete()).toBe(false);
    const all = reader.fetchAll();
    // A read inside the file while it is in flight waits on the download.
    const read = reader.read(100 * KB, 120 * KB);
    const pending = { count: 1 };
    void all.then(() => {
      pending.count = 0;
    });
    while (pending.count > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
    }
    expect(isRange(await read, 100 * KB)).toBe(true);
    expect(sizes()).toEqual([64, 6 * 1024 - 64]);
    expect(reader.isComplete()).toBe(true);
  });

  it('joins a download already running instead of opening a second stream', async () => {
    const { ranges, fetchFn, release } = throttledServer(6 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    const sized = reader.getSize();
    release();
    await sized;
    const first = reader.fetchAll();
    const second = reader.fetchAll();
    expect(reader.isDownloading()).toBe(true);
    const pending = { count: 1 };
    void Promise.all([first, second]).then(() => {
      pending.count = 0;
    });
    while (pending.count > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
    }
    expect(ranges.length).toBe(2);
    expect(reader.isDownloading()).toBe(false);
  });

  it('drop() stops a stream in flight', async () => {
    const { fetchFn, release } = throttledServer(6 * MB);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    const sized = reader.getSize();
    release();
    await sized;
    const all = reader.fetchAll();
    reader.drop();
    release();
    await expect(all).rejects.toThrow();
    expect(reader.isComplete()).toBe(false);
    expect(reader.isDownloading()).toBe(false);
  });

  it('a read waiting on the stream survives a dropped connection; the retry resumes', async () => {
    vi.useFakeTimers();
    try {
      const size = 1 * MB;
      const server = fakeServer(size);
      let failures = 1;
      const fetchFn: typeof server.fetchFn = async (url, init) => {
        const whole = await server.fetchFn(url, init);
        // Only the stream drops; the header read before it is fine.
        const range = new Headers(init?.headers).get('range') ?? '';
        if (failures === 0 || !range.endsWith(`-${size - 1}`)) return whole;
        failures--;
        // Deliver four blocks, then the connection drops.
        const body = new Uint8Array(await whole.arrayBuffer());
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0)
              controller.enqueue(body.subarray(0, 4 * 64 * KB));
            else controller.error(new TypeError('Failed to fetch'));
          },
        });
        return new Response(stream, {
          status: 206,
          headers: whole.headers,
        });
      };
      const reader = createRangedReader('/clip.mp4', fetchFn);
      await reader.getSize();
      const all = reader.fetchAll();
      const read = reader.read(600 * KB, 601 * KB);
      await vi.advanceTimersByTimeAsync(5000);
      await all;
      expect(isRange(await read, 600 * KB)).toBe(true);
      expect(server.ranges.at(-1)).toBe(`bytes=${5 * 64 * KB}-${size - 1}`);
      expect(reader.isComplete()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a file past the cache limit until dropped', async () => {
    const size = 24 * MB;
    const { ranges, fetchFn } = fakeServer(size);
    const reader = createRangedReader('/clip.mp4', fetchFn);
    await reader.fetchAll();
    expect(reader.isComplete()).toBe(true);
    const before = ranges.length;
    expect(isRange(await reader.read(0, 40), 0)).toBe(true);
    expect(isRange(await reader.read(size - 40, size), size - 40)).toBe(true);
    expect(ranges.length).toBe(before);
    reader.drop();
    expect(reader.isComplete()).toBe(false);
    await reader.read(0, 40);
    expect(ranges.length).toBe(before + 1);
  });
});
