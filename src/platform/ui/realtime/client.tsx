import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import type { realtimeSchema } from '@/platform/realtime';
import {
  combineRealtimeStatus,
  jitterReconnectDelay,
  nextClientReconnectDelay,
  partitionRealtimeChannels,
  REALTIME_HARD_FAIL_ATTEMPTS,
  REALTIME_STABLE_OPEN_MS,
} from '@/platform/realtime/sse-session';
import type {
  ConnectionStatus,
  EventPaths,
  EventPayloadUnion,
  RealtimeUserEvent,
} from '@/platform/server/realtime/shared-types';

/**
 * At most two EventSources: `billing:*`, then every other channel.
 * One stream per channel deadlocks the origin (browsers allow six).
 * A dropped stream is closed and reopened with jittered backoff.
 */

type Subscriber = (msg: RealtimeUserEvent) => void;

type RealtimeContextValue = {
  status: ConnectionStatus;
  register: (id: string, channels: string[], cb: Subscriber) => void;
  unregister: (id: string) => void;
};

export const RealtimeContext = createContext<RealtimeContextValue | null>(null);

type StreamGroup = 'billing' | 'heavy';

type LiveStream = {
  source: EventSource | null;
  key: string;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
  /** Clears the failure count only after the socket has stayed up. */
  stable: ReturnType<typeof setTimeout> | null;
};

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
  const streamsRef = useRef<Record<StreamGroup, LiveStream>>({
    billing: { source: null, key: '', attempt: 0, retry: null, stable: null },
    heavy: { source: null, key: '', attempt: 0, retry: null, stable: null },
  });
  const groupStatusRef = useRef<Record<StreamGroup, ConnectionStatus | null>>({
    billing: null,
    heavy: null,
  });
  const syncHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const publishStatus = (): void => {
    setStatus(
      combineRealtimeStatus(
        groupStatusRef.current.billing,
        groupStatusRef.current.heavy
      )
    );
  };

  const stopGroup = (group: StreamGroup): void => {
    const live = streamsRef.current[group];
    if (live.retry !== null) clearTimeout(live.retry);
    live.retry = null;
    if (live.stable !== null) clearTimeout(live.stable);
    live.stable = null;
    live.source?.close();
    live.source = null;
    live.key = '';
    live.attempt = 0;
    groupStatusRef.current[group] = null;
  };

  const connectGroup = (group: StreamGroup): void => {
    const live = streamsRef.current[group];
    const key = live.key;
    if (!key) return;
    const source = new EventSource(
      `/api/realtime?channels=${encodeURIComponent(key)}`
    );
    live.source = source;
    groupStatusRef.current[group] = 'connecting';
    publishStatus();

    source.onopen = () => {
      if (streamsRef.current[group].source !== source) return;
      groupStatusRef.current[group] = 'connected';
      publishStatus();
      if (live.stable !== null) clearTimeout(live.stable);
      // An isolate can accept the socket and then die. Keep the failure
      // count until the stream has stayed up for a ping interval.
      live.stable = setTimeout(() => {
        live.stable = null;
        if (streamsRef.current[group].source !== source) return;
        live.attempt = 0;
      }, REALTIME_STABLE_OPEN_MS);
    };
    source.onerror = () => {
      if (streamsRef.current[group].source !== source) return;
      // Read readyState before close(). CLOSED means the server refused the
      // stream (non-200); CONNECTING is a drop after the socket was up.
      const refused = source.readyState === EventSource.CLOSED;
      if (live.stable !== null) clearTimeout(live.stable);
      live.stable = null;
      live.source = null;
      source.close();
      const delay = jitterReconnectDelay(
        nextClientReconnectDelay(live.attempt),
        Math.random()
      );
      live.attempt += 1;
      groupStatusRef.current[group] =
        refused || live.attempt >= REALTIME_HARD_FAIL_ATTEMPTS
          ? 'error'
          : 'connecting';
      publishStatus();
      live.retry = setTimeout(() => {
        live.retry = null;
        if (streamsRef.current[group].key !== key) return;
        connectGroup(group);
      }, delay);
    };
    source.onmessage = (event) => {
      if (streamsRef.current[group].source !== source) return;
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

  const syncGroup = (group: StreamGroup, channels: string[]): void => {
    const key = [...channels].sort().join(',');
    const live = streamsRef.current[group];
    if (live.key === key && (live.source !== null || live.retry !== null))
      return;
    stopGroup(group);
    if (key.length === 0) {
      publishStatus();
      return;
    }
    live.key = key;
    live.attempt = 0;
    connectGroup(group);
  };

  const syncSource = (): void => {
    const channels = [
      ...new Set(
        [...subscriptionsRef.current.values()].flatMap((s) => s.channels)
      ),
    ];
    const groups = partitionRealtimeChannels(channels);
    syncGroup('billing', groups.billing);
    syncGroup('heavy', groups.heavy);
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
    const streams = streamsRef.current;
    return () => {
      if (syncHandleRef.current !== null) clearTimeout(syncHandleRef.current);
      for (const group of ['billing', 'heavy'] as const) {
        const live = streams[group];
        if (live.retry !== null) clearTimeout(live.retry);
        live.retry = null;
        if (live.stable !== null) clearTimeout(live.stable);
        live.stable = null;
        live.source?.close();
        live.source = null;
        live.key = '';
      }
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
