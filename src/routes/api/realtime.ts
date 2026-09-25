import { getEnv } from '#env';
import { createFileRoute } from '@tanstack/react-router';
import { authRequestMiddleware } from '@/platform/middleware.fn';
import { getLogger } from '@/platform/logger';
import {
  coalesceKeyForSsePayload,
  createSseReassembly,
  createSseWriteQueue,
  isBillingSsePayload,
  isSystemSsePayload,
  MERGED_SSE_MAX_FRAME_BYTES,
  MERGED_SSE_MAX_PENDING,
  MERGED_SSE_MAX_PENDING_BYTES,
  pushSseText,
} from '@/platform/server/realtime/merged-sse';

const logger = getLogger(['openstory', 'realtime', 'merged']);

/**
 * SSE subscription endpoint. One request carries *many* channels: the client
 * opens a single `EventSource` for the union of everything it is subscribed to
 * (see `client.tsx`) and this handler fans that out to one `RealtimeChannel`
 * Durable Object per channel, merging their streams back into one response.
 *
 * Billing is a second EventSource (`sse-session.ts`). It used to share this
 * response with talent and sequence payloads; a stalled browser plus a chatty
 * billing channel, or one full-scene `shot:updated`, filled the isolate until
 * Cloudflare killed it with `exceededMemory` (#1792). Workers memory is 128 MB
 * per isolate and cannot be raised.
 *
 * The multiplexing is not an optimisation — it is required for correctness.
 * Browsers cap concurrent HTTP/1.1 connections per origin at 6, and an SSE
 * stream holds its connection for its entire life. One `EventSource` per
 * channel therefore deadlocked the whole origin as soon as a page rendered ~5
 * cards (each subscribing to its own channel) plus the billing pill: every
 * later request — route chunks, server functions, images — queued forever
 * behind the streams and the app silently stopped navigating (#827). Two
 * streams (billing, everything else) stay under that cap.
 */

/** Hard cap so one subscriber can't fan a single request out to unbounded DOs. */
const MAX_CHANNELS = 64;
/** Keepalive cadence for the merged stream. Sub-stream pings are filtered out. */
const PING_INTERVAL_MS = 25_000;
/** First pause before re-subscribing a dropped DO stream (#1332). */
const RECONNECT_MIN_MS = 250;
/** Cap so a crashing DO cannot tight-loop `/subscribe`. */
const RECONNECT_MAX_MS = 5_000;
/** Don't emit a shed warning more than once per response per this window. */
const SHED_LOG_INTERVAL_MS = 10_000;

function nextReconnectDelay(currentMs: number): number {
  if (currentMs < RECONNECT_MIN_MS) return RECONNECT_MIN_MS;
  return Math.min(currentMs * 2, RECONNECT_MAX_MS);
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const Route = createFileRoute('/api/realtime')({
  server: {
    middleware: [authRequestMiddleware],
    handlers: {
      GET: ({ request }) => {
        const params = new URL(request.url).searchParams;
        // `channel` (singular) is still accepted so a tab left open across a
        // deploy keeps streaming instead of erroring until the user reloads.
        const requested = params.get('channels') ?? params.get('channel') ?? '';
        const channels = [
          ...new Set(
            requested
              .split(',')
              .map((channel) => channel.trim())
              .filter(Boolean)
          ),
        ].slice(0, MAX_CHANNELS);

        if (channels.length === 0) {
          return new Response('missing channels', { status: 400 });
        }

        // getEnv()'s type is platform-dependent; the Cloudflare runtime
        // guarantees the Cloudflare.Env shape with the REALTIME binding.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- platform-dependent env shape
        const namespace = (getEnv() as unknown as Cloudflare.Env).REALTIME;

        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        const writer = writable.getWriter();
        const abort = new AbortController();

        let closed = false;
        let lastShedLog = 0;
        const noteShed = (bytes: number): void => {
          const now = Date.now();
          if (now - lastShedLog < SHED_LOG_INTERVAL_MS) return;
          lastShedLog = now;
          logger.warn('shedding SSE frame', {
            bytes,
            channels: channels.length,
          });
        };

        // Writes are chained so frames from different channels can never
        // interleave mid-frame. A full queue sheds a frame — it does not
        // close the response. Closing reconnected every tab at once and
        // that storm is what exhausted isolate memory (#1792).
        const queue = createSseWriteQueue({
          maxPending: MERGED_SSE_MAX_PENDING,
          maxBytes: MERGED_SSE_MAX_PENDING_BYTES,
          write: (frame) => writer.write(frame),
          onShed: (shed) => noteShed(shed.bytes),
          onFatal: () => close(),
        });

        const sendPayload = (
          payload: string,
          coalesceKey: string | null
        ): void => {
          if (closed) return;
          queue.enqueue(
            encoder.encode(`data: ${payload}\n\n`),
            coalesceKey,
            isBillingSsePayload(payload)
          );
        };

        const sendJson = (
          payload: unknown,
          coalesceKey: string | null
        ): void => {
          sendPayload(JSON.stringify(payload), coalesceKey);
        };

        const ping = setInterval(
          () => sendJson({ type: 'ping' }, 'system:ping'),
          PING_INTERVAL_MS
        );

        function close(): void {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          queue.close();
          abort.abort();
          void writer.close().catch(() => {});
        }

        request.signal.addEventListener('abort', close);

        const drain = async (
          body: ReadableStream<Uint8Array>
        ): Promise<void> => {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          const reassembly = createSseReassembly();
          try {
            let reading = true;
            while (reading && !closed) {
              const result = await reader.read();
              if (result.done) {
                reading = false;
                continue;
              }
              const { frames, shedOversized } = pushSseText(
                reassembly,
                decoder.decode(result.value, { stream: true }),
                MERGED_SSE_MAX_FRAME_BYTES
              );
              if (shedOversized > 0) noteShed(MERGED_SSE_MAX_FRAME_BYTES);
              for (const payload of frames) {
                // Each DO emits its own connected/ping frames; the merged
                // stream publishes exactly one of each instead of N.
                if (isSystemSsePayload(payload)) continue;
                sendPayload(payload, coalesceKeyForSsePayload(payload));
              }
            }
          } finally {
            try {
              await reader.cancel();
            } catch {
              // already cancelled / released
            }
          }
        };

        const pump = async (channel: string): Promise<void> => {
          // Re-subscribe if this channel's DO stream ends (overflow close
          // #1332, or an isolate reset). Live events only — missed frames
          // are not replayed from `/history`. Sibling pumps keep the merged
          // EventSource up. Errors and empty bodies retry with backoff so a
          // reset cannot silently kill one multiplexed channel, and a billing
          // burst cannot tight-loop `/subscribe`.
          let delayMs = 0;
          while (!closed) {
            try {
              if (delayMs > 0) {
                await waitForReconnect(delayMs, abort.signal);
              }
              const stub = namespace.get(namespace.idFromName(channel));
              const response = await stub.fetch(
                new Request(
                  `https://realtime.do/subscribe?channel=${encodeURIComponent(channel)}`,
                  { signal: abort.signal }
                )
              );
              if (!response.body) {
                delayMs = nextReconnectDelay(delayMs);
                continue;
              }
              await drain(response.body);
              delayMs = nextReconnectDelay(delayMs);
            } catch {
              if (abort.signal.aborted) return;
              delayMs = nextReconnectDelay(delayMs);
            }
          }
        };

        // Deliberately not awaited: the response must reach the browser before
        // the sub-streams (which never end) are drained.
        void Promise.all(
          channels.map((channel) =>
            pump(channel).catch(() => {
              // One unreachable channel must not tear down the others.
            })
          )
        ).then(close, close);

        sendJson({ type: 'connected', channels }, null);

        return new Response(readable, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      },
    },
  },
});
