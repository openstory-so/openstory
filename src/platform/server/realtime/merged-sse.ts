/**
 * Bound the merged `/api/realtime` write queue.
 *
 * The Durable Object already drops a slow `/subscribe` consumer
 * (`SSE_MAX_BUFFERED_CHUNKS`). The Worker that multiplexes those streams into
 * one EventSource did not: each `send()` closed over its payload on a promise
 * chain, so a stalled browser + a chatty `billing:` channel buffered every
 * subsequent event in the Worker isolate until it hit the memory limit.
 */

export const MERGED_SSE_MAX_PENDING = 32;

export function createPendingWriteGate(
  maxPending: number,
  onOverflow: () => void
): { tryAcquire: () => boolean; release: () => void } {
  let pending = 0;
  return {
    tryAcquire(): boolean {
      if (pending >= maxPending) {
        onOverflow();
        return false;
      }
      pending += 1;
      return true;
    },
    release(): void {
      pending = Math.max(0, pending - 1);
    },
  };
}
