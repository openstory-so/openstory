import { describe, expect, it, vi } from 'vitest';
import { createPendingWriteGate, MERGED_SSE_MAX_PENDING } from './merged-sse';

describe('createPendingWriteGate', () => {
  it('acquires up to the cap then overflows', () => {
    const onOverflow = vi.fn();
    const gate = createPendingWriteGate(2, onOverflow);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('releases a slot so a later acquire succeeds', () => {
    const onOverflow = vi.fn();
    const gate = createPendingWriteGate(1, onOverflow);
    expect(gate.tryAcquire()).toBe(true);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it('pins the merged SSE cap used by /api/realtime', () => {
    expect(MERGED_SSE_MAX_PENDING).toBe(32);
  });
});
