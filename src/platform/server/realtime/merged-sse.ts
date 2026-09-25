/**
 * Bound the merged `/api/realtime` write queue (#1792).
 *
 * The Durable Object drops a slow `/subscribe` consumer
 * (`SSE_MAX_BUFFERED_CHUNKS` / `SSE_MAX_BUFFERED_BYTES`). The Worker that
 * multiplexes those streams used to keep every encoded frame on a promise
 * chain and, once the chain hit 32, **close the response**. The browser
 * reopened immediately, each tab re-subscribed every talent and sequence
 * channel, and the isolate — 128 MB, not raisable — hit `exceededMemory`
 * on `GET /api/realtime`.
 *
 * Shed instead of closing: drop or replace a queued frame, keep the
 * response open, and prefer a `billing:` frame over a talent/sequence one.
 * One in-flight scene update fits; a burst of them does not.
 */

/** Queued frames (not bytes). Tiny billing events hit this before the byte cap. */
export const MERGED_SSE_MAX_PENDING = 8;
/** Encoded bytes retained for one EventSource. One scene frame fits; two do not. */
export const MERGED_SSE_MAX_PENDING_BYTES = 512 * 1024;
/**
 * A single DO frame above this is discarded while reassembling. The string
 * is never appended, so one oversized `shot:updated` cannot pin the isolate.
 */
export const MERGED_SSE_MAX_FRAME_BYTES = 512 * 1024;

const COALESCE_PARSE_LIMIT = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
const PROGRESS_SUBJECT_KEYS = [
  'shotId',
  'talentId',
  'locationId',
  'sceneId',
] as const;

export type SseReassembly = {
  buffer: string;
  discarding: boolean;
};

export function createSseReassembly(): SseReassembly {
  return { buffer: '', discarding: false };
}

/** `data:` payload, or `null` when the frame is empty. */
function payloadFromFrame(raw: string): string | null {
  const payload = raw.startsWith('data:') ? raw.slice(5).trim() : '';
  return payload.length > 0 ? payload : null;
}

/**
 * Append one decoded chunk. Frames larger than `maxFrameBytes` are counted
 * in `shedOversized` and are not returned. A partial oversized frame sets
 * `discarding` until the next `\n\n` so the tail is not buffered.
 */
export function pushSseText(
  state: SseReassembly,
  text: string,
  maxFrameBytes: number
): { frames: string[]; shedOversized: number } {
  let shed = 0;
  let rest = text;
  const frames: string[] = [];

  const take = (raw: string): void => {
    const payload = payloadFromFrame(raw);
    if (!payload) return;
    if (payload.length > maxFrameBytes) {
      shed += 1;
      return;
    }
    frames.push(payload);
  };

  while (rest.length > 0) {
    if (state.discarding) {
      const end = rest.indexOf('\n\n');
      if (end === -1) return { frames, shedOversized: shed };
      state.discarding = false;
      rest = rest.slice(end + 2);
      continue;
    }

    const boundary = rest.indexOf('\n\n');
    if (boundary === -1) {
      if (state.buffer.length + rest.length > maxFrameBytes) {
        state.buffer = '';
        state.discarding = true;
        shed += 1;
        return { frames, shedOversized: shed };
      }
      state.buffer += rest;
      return { frames, shedOversized: shed };
    }

    if (state.buffer.length + boundary > maxFrameBytes) {
      shed += 1;
      state.buffer = '';
      rest = rest.slice(boundary + 2);
      continue;
    }

    const raw = state.buffer + rest.slice(0, boundary);
    state.buffer = '';
    rest = rest.slice(boundary + 2);
    take(raw);
  }

  return { frames, shedOversized: shed };
}

/** DO keepalive / connected frames. User events start with `{"id":`. */
export function isSystemSsePayload(payload: string): boolean {
  return payload.startsWith('{"type":');
}

export function isBillingSsePayload(payload: string): boolean {
  return payload.includes('"event":"billing.balance:updated"');
}

/**
 * Latest-wins key while the frame is still queued. `null` means the frame
 * must not replace another (one-shot events, and anything big enough that
 * parsing it would cost the memory we are trying to save).
 */
export function coalesceKeyForSsePayload(payload: string): string | null {
  if (payload.length > COALESCE_PARSE_LIMIT || !payload.startsWith('{')) {
    return null;
  }
  if (payload.startsWith('{"type":"ping"')) return 'system:ping';

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.event !== 'string' || typeof parsed.channel !== 'string') {
    return null;
  }
  if (parsed.event === 'billing.balance:updated') {
    return `${parsed.channel}\0${parsed.event}`;
  }
  const isProgress =
    parsed.event.endsWith(':progress') ||
    parsed.event === 'shotPrompt.streaming';
  if (!isProgress || !isRecord(parsed.data)) return null;
  const data = parsed.data;
  const subject = PROGRESS_SUBJECT_KEYS.map((key) => data[key]).find(
    (value): value is string => typeof value === 'string'
  );
  if (!subject) return null;
  const promptType = typeof data.promptType === 'string' ? data.promptType : '';
  return `${parsed.channel}\0${parsed.event}\0${subject}\0${promptType}`;
}

type QueuedFrame = {
  frame: Uint8Array;
  key: string | null;
  billing: boolean;
};

export function createSseWriteQueue(opts: {
  maxPending: number;
  maxBytes: number;
  write: (frame: Uint8Array) => Promise<void>;
  onShed: (shed: { bytes: number; billing: boolean }) => void;
  onFatal: () => void;
}): {
  enqueue: (frame: Uint8Array, key: string | null, billing: boolean) => void;
  close: () => void;
} {
  let items: QueuedFrame[] = [];
  let writing = false;
  let closed = false;

  const queuedBytes = (): number => {
    let total = 0;
    for (const item of items) total += item.frame.byteLength;
    return total;
  };

  const over = (): boolean =>
    items.length > opts.maxPending || queuedBytes() > opts.maxBytes;

  const shed = (item: QueuedFrame): void => {
    opts.onShed({ bytes: item.frame.byteLength, billing: item.billing });
  };

  /** Drop queued frames until `protectedItem` fits. Billing outranks the rest. */
  const trim = (protectedItem: QueuedFrame): void => {
    while (over()) {
      const victim =
        items.find((item) => item !== protectedItem && !item.billing) ??
        (protectedItem.billing
          ? items.find((item) => item !== protectedItem)
          : undefined);
      if (!victim) {
        if (over() && items.includes(protectedItem)) {
          items = items.filter((item) => item !== protectedItem);
          shed(protectedItem);
        }
        return;
      }
      items = items.filter((item) => item !== victim);
      shed(victim);
    }
  };

  const pump = (): void => {
    if (writing || closed) return;
    writing = true;
    const run = (): void => {
      if (closed || items.length === 0) {
        writing = false;
        return;
      }
      const next = items.shift();
      if (!next) {
        writing = false;
        return;
      }
      opts.write(next.frame).then(
        () => run(),
        () => {
          closed = true;
          writing = false;
          items = [];
          opts.onFatal();
        }
      );
    };
    run();
  };

  return {
    enqueue(frame, key, billing) {
      if (closed) return;
      if (key) {
        const existing = items.findIndex((item) => item.key === key);
        if (existing !== -1) {
          const replaced: QueuedFrame = { frame, key, billing };
          items[existing] = replaced;
          trim(replaced);
          return;
        }
      }
      const incoming: QueuedFrame = { frame, key, billing };
      items.push(incoming);
      trim(incoming);
      pump();
    },
    close() {
      closed = true;
      items = [];
    },
  };
}
