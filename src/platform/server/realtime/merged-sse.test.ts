import { describe, expect, it, vi } from 'vitest';
import {
  coalesceKeyForSsePayload,
  createSseReassembly,
  createSseWriteQueue,
  isSystemSsePayload,
  MERGED_SSE_MAX_FRAME_BYTES,
  MERGED_SSE_MAX_PENDING,
  MERGED_SSE_MAX_PENDING_BYTES,
  pushSseText,
} from './merged-sse';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(body: string): Uint8Array {
  return encoder.encode(body);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('pushSseText', () => {
  it('splits complete frames and keeps a partial tail', () => {
    const state = createSseReassembly();
    const first = pushSseText(state, 'data: {"id":"1"}\n\ndata: {"id":', 100);
    expect(first.frames).toEqual(['{"id":"1"}']);
    expect(first.shedOversized).toBe(0);
    const second = pushSseText(state, '"2"}\n\n', 100);
    expect(second.frames).toEqual(['{"id":"2"}']);
    expect(state.buffer).toBe('');
  });

  it('sheds a frame larger than the cap without retaining it', () => {
    const state = createSseReassembly();
    const huge = `data: ${'x'.repeat(40)}\n\ndata: {"ok":1}\n\n`;
    const result = pushSseText(state, huge, 16);
    expect(result.frames).toEqual(['{"ok":1}']);
    expect(result.shedOversized).toBe(1);
    expect(state.buffer).toBe('');
    expect(state.discarding).toBe(false);
  });

  it('discards a partial oversized frame until the next boundary', () => {
    const state = createSseReassembly();
    const started = pushSseText(state, 'x'.repeat(20), 8);
    expect(started.frames).toEqual([]);
    expect(started.shedOversized).toBe(1);
    expect(state.buffer).toBe('');
    expect(state.discarding).toBe(true);

    const resumed = pushSseText(state, 'more\n\ndata: {"n":1}\n\n', 32);
    expect(resumed.frames).toEqual(['{"n":1}']);
    expect(state.discarding).toBe(false);
  });
});

describe('coalesceKeyForSsePayload', () => {
  it('keys billing and per-subject progress, and ignores one-shot events', () => {
    expect(isSystemSsePayload('{"type":"ping"}')).toBe(true);
    expect(
      coalesceKeyForSsePayload(
        JSON.stringify({
          id: '1',
          event: 'billing.balance:updated',
          channel: 'billing:team',
          data: { balanceUsd: 1 },
        })
      )
    ).toBe('billing:team\0billing.balance:updated');

    expect(
      coalesceKeyForSsePayload(
        JSON.stringify({
          id: '2',
          event: 'generation.image:progress',
          channel: 'seq',
          data: { shotId: 'shot-a', status: 'generating' },
        })
      )
    ).toBe('seq\0generation.image:progress\0shot-a\0');

    expect(
      coalesceKeyForSsePayload(
        JSON.stringify({
          id: '3',
          event: 'generation.shot:updated',
          channel: 'seq',
          data: { shotId: 'shot-a' },
        })
      )
    ).toBeNull();
  });

  it('does not parse a payload above the coalesce limit', () => {
    const payload = JSON.stringify({
      id: '1',
      event: 'billing.balance:updated',
      channel: 'billing:team',
      data: { blob: 'x'.repeat(9_000) },
    });
    expect(payload.length).toBeGreaterThan(8_192);
    expect(coalesceKeyForSsePayload(payload)).toBeNull();
  });
});

describe('createSseWriteQueue', () => {
  it('writes frames in order', async () => {
    const written: string[] = [];
    const queue = createSseWriteQueue({
      maxPending: 4,
      maxBytes: 100,
      write: async (bytes) => {
        written.push(decoder.decode(bytes));
      },
      onShed: vi.fn(),
      onFatal: vi.fn(),
    });
    queue.enqueue(frame('a'), null, false);
    queue.enqueue(frame('b'), null, false);
    await vi.waitFor(() => expect(written).toEqual(['a', 'b']));
  });

  it('replaces a queued frame with the same coalesce key', async () => {
    const written: string[] = [];
    const hold = deferred();
    let held = false;
    const queue = createSseWriteQueue({
      maxPending: 4,
      maxBytes: 100,
      write: async (bytes) => {
        if (!held) {
          held = true;
          await hold.promise;
        }
        written.push(decoder.decode(bytes));
      },
      onShed: vi.fn(),
      onFatal: vi.fn(),
    });
    queue.enqueue(frame('first'), 'bill', true);
    await Promise.resolve();
    queue.enqueue(frame('old'), 'bill', true);
    queue.enqueue(frame('new'), 'bill', true);
    hold.resolve();
    await vi.waitFor(() => expect(written).toEqual(['first', 'new']));
  });

  it('sheds a normal frame to keep a queued billing frame', async () => {
    const onShed = vi.fn();
    const onFatal = vi.fn();
    const written: string[] = [];
    const hold = deferred();
    let held = false;
    const queue = createSseWriteQueue({
      maxPending: 4,
      maxBytes: 10,
      write: async (bytes) => {
        if (!held) {
          held = true;
          await hold.promise;
        }
        written.push(decoder.decode(bytes));
      },
      onShed,
      onFatal,
    });
    queue.enqueue(frame('hold'), null, false);
    await Promise.resolve();
    queue.enqueue(frame('12345678'), 'bill', true);
    queue.enqueue(frame('abcdefgh'), null, false);
    expect(onShed).toHaveBeenCalledWith({ bytes: 8, billing: false });
    expect(onFatal).not.toHaveBeenCalled();
    hold.resolve();
    await vi.waitFor(() => expect(written).toEqual(['hold', '12345678']));
  });

  it('closes the stream when the writer fails', async () => {
    const onFatal = vi.fn();
    const queue = createSseWriteQueue({
      maxPending: 4,
      maxBytes: 100,
      write: async () => {
        throw new Error('broken pipe');
      },
      onShed: vi.fn(),
      onFatal,
    });
    queue.enqueue(frame('a'), null, false);
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledOnce());
  });

  it('pins the caps used by /api/realtime', () => {
    expect(MERGED_SSE_MAX_PENDING).toBe(8);
    expect(MERGED_SSE_MAX_PENDING_BYTES).toBe(512 * 1024);
    expect(MERGED_SSE_MAX_FRAME_BYTES).toBe(512 * 1024);
  });
});
