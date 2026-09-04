import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import type { realtimeSchema } from './index';
import type {
  ConnectionStatus,
  EventPaths,
  EventPayloadUnion,
  RealtimeUserEvent,
} from './shared-types';

/**
 * In-repo realtime client (#802), replacing the removed Upstash-hosted realtime client.
 *
 * Exactly **one** `EventSource` is open at a time, carrying the union of every
 * channel the mounted hooks have registered: `/api/realtime?channels=a,b,c`
 * fans out to one `RealtimeChannel` Durable Object per channel server-side and
 * merges them back into that single stream. The DO holds each sub-stream open.
 * EventSource reconnects the merged `/api/realtime` response if it dies; the
 * worker also re-subscribes to a channel's DO if that sub-stream ends (#1332).
 *
 * One connection per channel is NOT a valid alternative: browsers cap
 * concurrent HTTP/1.1 connections per origin at 6, and an SSE stream holds its
 * connection open for life. A library page rendering ~5 cards (one channel
 * each) plus the billing pill exhausted that budget and wedged the entire
 * origin — every later navigation, server function and image request queued
 * behind the streams forever (#827).
 */

type Subscriber = (msg: RealtimeUserEvent) => void;

type RealtimeContextValue = {
  status: ConnectionStatus;
  register: (id: string, channels: string[], cb: Subscriber) => void;
  unregister: (id: string) => void;
};

export const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** Parse one SSE `data:` payload; `null` when it isn't a user event we deliver. */
function parseUserEvent(raw: string): RealtimeUserEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    'type' in payload // system event (connected / ping) — not delivered to subscribers
  ) {
    return null;
  }
  const evt = payload as Partial<RealtimeUserEvent>;
  if (typeof evt.event !== 'string' || typeof evt.channel !== 'string') {
    return null;
  }
  return {
    id: typeof evt.id === 'string' ? evt.id : '',
    event: evt.event,
    channel: evt.channel,
    data: evt.data,
  };
}

export const RealtimeProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const subscriptionsRef = useRef<
    Map<string, { channels: string[]; cb: Subscriber }>
  >(new Map());
  const sourceRef = useRef<EventSource | null>(null);
  /** Channel set the open stream was built for; empty when nothing is open. */
  const openKeyRef = useRef('');
  const syncHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const closeSource = (): void => {
    sourceRef.current?.close();
    sourceRef.current = null;
    openKeyRef.current = '';
  };

  const syncSource = (): void => {
    const channels = [
      ...new Set(
        [...subscriptionsRef.current.values()].flatMap((s) => s.channels)
      ),
    ].sort();
    const key = channels.join(',');
    if (key === openKeyRef.current) return;

    closeSource();
    if (channels.length === 0) {
      setStatus('disconnected');
      return;
    }

    const source = new EventSource(
      `/api/realtime?channels=${encodeURIComponent(key)}`
    );
    sourceRef.current = source;
    openKeyRef.current = key;
    setStatus('connecting');

    source.onopen = () => setStatus('connected');
    source.onerror = () => {
      // EventSource reconnects automatically; surface the transient error so
      // status-driven UI (toasts) can react, but don't tear the stream down.
      setStatus(
        source.readyState === EventSource.CLOSED ? 'error' : 'connecting'
      );
    };
    source.onmessage = (event) => {
      const msg = parseUserEvent(event.data);
      if (!msg) return;
      for (const {
        channels: subscribed,
        cb,
      } of subscriptionsRef.current.values()) {
        if (subscribed.includes(msg.channel)) cb(msg);
      }
    };
  };

  // Hooks register one at a time as they mount; coalescing to the end of the
  // tick means a page mounting N cards opens one stream, not N in sequence.
  const scheduleSync = (): void => {
    if (syncHandleRef.current !== null) return;
    syncHandleRef.current = setTimeout(() => {
      syncHandleRef.current = null;
      syncSource();
    }, 0);
  };

  const register = (id: string, channels: string[], cb: Subscriber): void => {
    subscriptionsRef.current.set(id, { channels, cb });
    scheduleSync();
  };

  const unregister = (id: string): void => {
    if (!subscriptionsRef.current.delete(id)) return;
    scheduleSync();
  };

  useEffect(() => {
    const subscriptions = subscriptionsRef.current;
    return () => {
      if (syncHandleRef.current !== null) clearTimeout(syncHandleRef.current);
      closeSource();
      subscriptions.clear();
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ status, register, unregister }}>
      {children}
    </RealtimeContext.Provider>
  );
};

interface UseRealtimeOpts<T, E extends string> {
  events?: readonly E[];
  onData?: (arg: EventPayloadUnion<T, E>) => void;
  channels?: readonly (string | undefined)[];
  enabled?: boolean;
}

function useRealtimeImpl<T, E extends string>(
  opts: UseRealtimeOpts<T, E>
): { status: ConnectionStatus } {
  const { channels = [], events, onData, enabled } = opts;
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error(
      'useRealtime: No RealtimeProvider found. Wrap the app in <RealtimeProvider>.'
    );
  }

  const registrationId = useRef(Math.random().toString(36).slice(2)).current;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const { register, unregister } = context;
  const channelsKey = JSON.stringify(channels);
  const eventsKey = JSON.stringify(events);

  useEffect(() => {
    if (enabled === false) {
      unregister(registrationId);
      return;
    }
    const validChannels = channels.filter((channel): channel is string =>
      Boolean(channel)
    );
    if (validChannels.length === 0) {
      unregister(registrationId);
      return;
    }

    register(registrationId, validChannels, (msg) => {
      if (
        events &&
        events.length > 0 &&
        !events.some((name) => name === msg.event)
      ) {
        return;
      }
      // The DO delivers the channel's events untyped; the `events` filter above
      // guarantees `msg` matches one of the requested paths, but TS can't prove
      // the narrowing at this typed/untyped boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime-validated event/payload boundary
      onDataRef.current?.({
        event: msg.event,
        channel: msg.channel,
        data: msg.data,
      } as unknown as EventPayloadUnion<T, E>);
    });

    return () => unregister(registrationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey, eventsKey, enabled]);

  return { status: context.status };
}

/**
 * Type-safe `useRealtime` factory. Binding to `typeof realtimeSchema` gives the
 * same event-name + payload inference the call sites relied on under Upstash.
 */
function createRealtime<T extends Record<string, unknown>>() {
  return {
    useRealtime: <const E extends EventPaths<T>>(opts: UseRealtimeOpts<T, E>) =>
      useRealtimeImpl<T, E>(opts),
  };
}

export const { useRealtime } = createRealtime<typeof realtimeSchema>();
