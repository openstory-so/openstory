/**
 * A mediabunny `Source` over bounded HTTP range requests (#1845).
 *
 * `UrlSource` opens every file with an open-ended request and a network
 * read-ahead that starts at 512 KiB: 20 clips cost ~10 MB before the first
 * frame, where their headers are ~20 KB (faststart). Here reads come in
 * 64 KiB blocks, one request for a clip's header, and the read-ahead only
 * doubles while reads stay sequential (a clip being played), up to 2 MiB.
 * `fetchAll` streams the whole file in one request and holds it, so the
 * player can download a clip ahead of the playhead and know when it is all
 * here (#2124). A video clip's header still comes through `ensure`; its
 * body comes through `fetchAll`, so the doubling read-ahead now serves
 * music and a still's lines.
 */

import { CustomSource } from 'mediabunny';

const BLOCK = 64 * 1024;
const MAX_AHEAD_BLOCKS = 32; // 2 MiB
/**
 * Per source, while `fetchAll` is not holding it: music, a still's lines
 * over HTTP, a dropped clip. A held video clip is exempt.
 */
const MAX_CACHED_BLOCKS = 256; // 16 MiB
const RETRY_DELAYS_MS = [500, 1500, 4000];

type FetchFn = typeof fetch;

export type RangedReader = ReturnType<typeof createRangedReader>;

/** The reads behind {@link createRangedSource}; exported for its test. */
export function createRangedReader(
  url: string,
  fetchFn: FetchFn = (...args) => fetch(...args)
) {
  const blocks = new Map<number, Uint8Array>();
  const inFlight = new Map<number, Promise<void>>();
  const abort = new AbortController();
  let size: number | null = null;
  let nextSequentialBlock = -1;
  let ahead = 1;
  /** Set by `fetchAll`: the whole file stays until `drop()`. */
  let held = false;
  /** The `fetchAll` in flight, handed to a second caller instead of a second stream. */
  let running: Promise<void> | null = null;
  /** Aborts the `fetchAll` in flight; `drop()` fires it. */
  let downloadAbort = new AbortController();

  async function fetchRange(first: number, last: number): Promise<void> {
    const start = first * BLOCK;
    const end =
      size === null ? (last + 1) * BLOCK : Math.min(size, (last + 1) * BLOCK);
    let response: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetchFn(url, {
          headers: { Range: `bytes=${start}-${end - 1}` },
          signal: abort.signal,
        });
        if (response.status !== 206) {
          throw new Error(`HTTP ${response.status} for ${url}`);
        }
        break;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (abort.signal.aborted || delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
    const bytes = new Uint8Array(await response.arrayBuffer());
    size ??= total ? Number(total[1]) : start + bytes.byteLength;
    for (let b = first; b * BLOCK < start + bytes.byteLength; b++) {
      const from = (b - first) * BLOCK;
      blocks.delete(b); // re-insert: Map order is the LRU order
      blocks.set(
        b,
        bytes.subarray(from, Math.min(from + BLOCK, bytes.byteLength))
      );
    }
    while (!held && blocks.size > MAX_CACHED_BLOCKS) {
      const oldest = blocks.keys().next().value;
      if (oldest === undefined) break;
      blocks.delete(oldest);
    }
  }

  type Waiter = { resolve: () => void; reject: (error: unknown) => void };

  /**
   * Stream the file from block `first` to its end in one request, storing
   * each block as it lands and settling its waiter, so a read waiting on
   * it goes on at once. Waiters survive a failed attempt: the caller
   * retries and rejects them only when it gives up.
   */
  async function streamFrom(
    first: number,
    total: number,
    waiters: Map<number, Waiter>,
    signal: AbortSignal
  ): Promise<void> {
    const last = Math.ceil(total / BLOCK) - 1;
    const response = await fetchFn(url, {
      headers: { Range: `bytes=${first * BLOCK}-${total - 1}` },
      signal,
    });
    if (response.status !== 206 || response.body === null) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const reader = response.body.getReader();
    const dropped = () => {
      if (signal.aborted) throw signal.reason ?? new Error(`${url} dropped`);
    };
    dropped();
    let b = first;
    let block = new Uint8Array(BLOCK);
    let fill = 0;
    const blockSize = (index: number) => Math.min(BLOCK, total - index * BLOCK);
    for (;;) {
      const { done, value } = await reader.read();
      dropped();
      if (done) break;
      let from = 0;
      while (from < value.byteLength && b <= last) {
        const take = Math.min(blockSize(b) - fill, value.byteLength - from);
        block.set(value.subarray(from, from + take), fill);
        fill += take;
        from += take;
        if (fill === blockSize(b)) {
          blocks.set(b, block.subarray(0, fill));
          waiters.get(b)?.resolve();
          waiters.delete(b);
          b++;
          block = new Uint8Array(BLOCK);
          fill = 0;
        }
      }
    }
    if (b <= last) throw new Error(`${url} ended at block ${b} of ${last}`);
  }

  /**
   * Stream the whole file, from the first block not yet cached, retrying a
   * dropped connection from the last block that landed. A read waiting on
   * a block fails only once the retries are spent or the download is
   * dropped, the same three tries `fetchRange` gives it.
   */
  async function download(signal: AbortSignal): Promise<void> {
    if (size === null) await ensure(0, 0);
    if (size === null) throw new Error(`No size for ${url}`);
    const total = size;
    const last = Math.ceil(total / BLOCK) - 1;
    const waiters = new Map<number, Waiter>();
    for (let b = 0; b <= last; b++) {
      if (blocks.has(b) || inFlight.has(b)) continue;
      const landed = new Promise<void>((resolve, reject) => {
        waiters.set(b, { resolve, reject });
      });
      const tracked = landed.finally(() => inFlight.delete(b));
      tracked.catch(() => {}); // the waiting read reports it
      inFlight.set(b, tracked);
    }
    try {
      for (let attempt = 0; ; attempt++) {
        let first = 0;
        while (first <= last && blocks.has(first)) first++;
        if (first > last) return;
        try {
          await streamFrom(first, total, waiters, signal);
          return;
        } catch (error) {
          const delay = RETRY_DELAYS_MS[attempt];
          if (signal.aborted || delay === undefined) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      for (const waiter of waiters.values()) waiter.reject(error);
      throw error;
    }
  }

  /** The bytes [start, end) from cached blocks, or null if one is missing. */ /** The bytes [start, end) from cached blocks, or null if one is missing. */
  function copyOut(
    start: number,
    end: number,
    first: number,
    last: number
  ): Uint8Array | null {
    const out = new Uint8Array(end - start);
    for (let b = first; b <= last; b++) {
      const block = blocks.get(b);
      if (!block) return null;
      blocks.delete(b); // re-insert: a read keeps the block recent
      blocks.set(b, block);
      const blockStart = b * BLOCK;
      const from = Math.max(start, blockStart);
      const to = Math.min(end, blockStart + block.byteLength);
      out.set(block.subarray(from - blockStart, to - blockStart), from - start);
    }
    return out;
  }

  /** Fetch every missing block in [first, last], as few requests as possible. */
  async function ensure(first: number, wanted: number): Promise<void> {
    // Never past the end of the file: a run clamped below its own start
    // would be issued again forever.
    const last =
      size === null ? wanted : Math.min(wanted, Math.ceil(size / BLOCK) - 1);
    const waits: Promise<void>[] = [];
    let b = first;
    while (b <= last) {
      const pending = inFlight.get(b);
      if (blocks.has(b) || pending) {
        if (pending) waits.push(pending);
        b++;
        continue;
      }
      // A read that picks up where the last one ended is a clip playing:
      // grow the read-ahead. Anything else (a header, a seek) starts small.
      ahead =
        b === nextSequentialBlock ? Math.min(ahead * 2, MAX_AHEAD_BLOCKS) : 1;
      let runEnd = Math.max(b + ahead - 1, last);
      if (size !== null) runEnd = Math.min(runEnd, Math.ceil(size / BLOCK) - 1);
      for (let k = b + 1; k <= runEnd; k++) {
        if (blocks.has(k) || inFlight.has(k)) {
          runEnd = k - 1;
          break;
        }
      }
      // Constants: `b` and `runEnd` move on before the run settles.
      const runStart = b;
      const runLast = runEnd;
      const run = fetchRange(runStart, runLast).finally(() => {
        for (let k = runStart; k <= runLast; k++) inFlight.delete(k);
      });
      for (let k = runStart; k <= runLast; k++) inFlight.set(k, run);
      waits.push(run);
      nextSequentialBlock = runLast + 1;
      b = runLast + 1;
    }
    await Promise.all(waits);
  }

  return {
    getSize: async (): Promise<number> => {
      if (size === null) await ensure(0, 0);
      if (size === null) throw new Error(`No size for ${url}`);
      return size;
    },
    read: async (start: number, end: number): Promise<Uint8Array> => {
      const first = Math.floor(start / BLOCK);
      const last = Math.floor((end - 1) / BLOCK);
      await ensure(first, last);
      // ponytail: fails if concurrent runs evict this read's blocks while it
      // waits (>16 MiB landing meanwhile); raise MAX_CACHED_BLOCKS if seen.
      const out = copyOut(start, end, first, last);
      if (!out) throw new Error(`Range ${start}-${end} of ${url} was evicted`);
      return out;
    },
    /**
     * Stream the whole file in one request, from the first block not yet
     * cached, storing blocks as they land. A second call while one runs
     * joins it. The file is held past the cache limit until `drop()`.
     */
    fetchAll: (): Promise<void> => {
      held = true;
      if (running) return running;
      const signal = AbortSignal.any([abort.signal, downloadAbort.signal]);
      running = download(signal).finally(() => {
        running = null;
      });
      return running;
    },
    /** True while a `fetchAll` is streaming. */
    isDownloading: (): boolean => running !== null,
    /**
     * True once every block of the file is cached. Keys are distinct and
     * never past the end, so a count is enough.
     */
    isComplete: (): boolean =>
      size !== null && blocks.size >= Math.ceil(size / BLOCK),
    /**
     * Forget the bytes (a read fetches again), stop a `fetchAll` in flight,
     * and stop holding the file.
     */
    drop: (): void => {
      held = false;
      downloadAbort.abort();
      downloadAbort = new AbortController();
      blocks.clear();
      ahead = 1;
    },
    dispose: () => {
      abort.abort();
      blocks.clear();
    },
  };
}

export function createRangedSource(url: string): CustomSource {
  return new CustomSource(createRangedReader(url));
}
