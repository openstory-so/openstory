/**
 * Bound the merged `/api/realtime` write queue.
 *
 * A full queue sheds a frame and keeps the response open. Closing it
 * reconnects every tab at once. One encoded frame fits; a burst does not.
 * Billing frames outrank the rest.
 */

/** Queued frames. Tiny billing events hit this before the byte cap. */
export const MERGED_SSE_MAX_PENDING = 8;
/**
 * Encoded bytes of one SSE frame. Reassembly uses the same cap, so a frame
 * that is forwarded still fits as the only queued item.
 */
export const MERGED_SSE_MAX_PENDING_BYTES = 512 * 1024;

const COALESCE_PARSE_LIMIT = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
const PROGRESS_SUBJECT_KEYS = [
  'shotId',
  'talentId',
  'locationId',
  'sceneId',
  'characterId',
] as const;

/** `data: ` plus the trailing blank line, on top of the payload bytes. */
const SSE_FRAMING_BYTES = 8;

export type SseReassembly = {
  buffer: string;
  discarding: boolean;
  /** Oversized frame ended on a newline, so a leading newline finishes it. */
  discardSawNl: boolean;
};

export function createSseReassembly(): SseReassembly {
  return { buffer: '', discarding: false, discardSawNl: false };
}

function utf8ByteLength(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      return new TextEncoder().encode(text).byteLength;
    }
  }
  return text.length;
}

function encodedSseFrameBytes(payload: string): number {
  return utf8ByteLength(payload) + SSE_FRAMING_BYTES;
}

/** `data:` payload, or `null` when the frame is empty. */
function payloadFromFrame(raw: string): string | null {
  const payload = raw.startsWith('data:') ? raw.slice(5).trim() : '';
  return payload.length > 0 ? payload : null;
}

/**
 * Append one decoded chunk. `maxFrameBytes` is the encoded frame size.
 * Oversized frames are not returned. A partial oversized frame is discarded
 * until its blank line, including when that blank line is split across chunks.
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
    if (encodedSseFrameBytes(payload) > maxFrameBytes) {
      shed += 1;
      return;
    }
    frames.push(payload);
  };

  const startDiscard = (sawNl: boolean): void => {
    state.buffer = '';
    state.discarding = true;
    state.discardSawNl = sawNl;
    shed += 1;
  };

  while (rest.length > 0) {
    if (state.discarding) {
      if (state.discardSawNl) {
        state.discardSawNl = false;
        if (rest.startsWith('\n')) {
          state.discarding = false;
          rest = rest.slice(1);
          continue;
        }
      }
      const end = rest.indexOf('\n\n');
      if (end === -1) {
        state.discardSawNl = rest.endsWith('\n');
        return { frames, shedOversized: shed };
      }
      state.discarding = false;
      rest = rest.slice(end + 2);
      continue;
    }

    const boundary = rest.indexOf('\n\n');
    if (boundary === -1) {
      if (utf8ByteLength(state.buffer) + utf8ByteLength(rest) > maxFrameBytes) {
        startDiscard(rest.endsWith('\n') || state.buffer.endsWith('\n'));
        return { frames, shedOversized: shed };
      }
      state.buffer += rest;
      return { frames, shedOversized: shed };
    }

    const raw = state.buffer + rest.slice(0, boundary);
    // `raw` omits the closing blank line; the written frame adds those 2 bytes.
    if (utf8ByteLength(raw) + 2 > maxFrameBytes) {
      shed += 1;
      state.buffer = '';
      state.discardSawNl = false;
      rest = rest.slice(boundary + 2);
      continue;
    }

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
  // Deltas append. Replacing one with the next deletes text the client
  // cannot rebuild until remount.
  if (parsed.event === 'shotPrompt.streaming') return null;
  if (!parsed.event.endsWith(':progress') || !isRecord(parsed.data))
    return null;
  const data = parsed.data;
  const subject =
    PROGRESS_SUBJECT_KEYS.map((key) => data[key]).find(
      (value): value is string => typeof value === 'string'
    ) ?? (parsed.event === 'generation.audio:progress' ? 'sequence' : null);
  if (!subject) return null;
  const promptType = typeof data.promptType === 'string' ? data.promptType : '';
  // Primary and alternate-model updates share a shot id. The cache updater
  // applies them to different rows, so they must not replace each other.
  const variantOnly = data.variantOnly === true ? '1' : '0';
  const model = typeof data.model === 'string' ? data.model : '';
  const activity = typeof data.activity === 'string' ? data.activity : '';
  return `${parsed.channel}\0${parsed.event}\0${subject}\0${promptType}\0${variantOnly}\0${model}\0${activity}`;
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
        // One frame at the cap stays. Reassembly already refused anything larger.
        if (
          items.length === 1 &&
          items[0] === protectedItem &&
          protectedItem.frame.byteLength <= opts.maxBytes
        ) {
          return;
        }
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
