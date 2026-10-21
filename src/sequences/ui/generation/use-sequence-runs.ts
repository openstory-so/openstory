import { getChannelRunsFn } from '@/platform/realtime-runs.fn';
import { useRealtime } from '@/platform/ui/realtime/client';
import { useEffect, useRef, useState } from 'react';
import {
  applyRunEvent,
  applyRunRead,
  beginRunSnapshot,
  EMPTY_RUN_STATE,
  type SequenceRunState,
  type WorkflowRun,
} from './sequence-runs';

/**
 * Open runs for one sequence (#2113). The snapshot is read after the
 * stream connects, then start and end events keep it current. Events that
 * arrive while the snapshot is in flight are applied on top of it.
 */
export function useSequenceRuns(sequenceId: string | undefined): WorkflowRun[] {
  const [bucket, setBucket] = useState<{
    id: string | undefined;
    state: SequenceRunState;
  }>({ id: sequenceId, state: EMPTY_RUN_STATE });
  // A different sequence must not flash the previous list. A reconnect of
  // the same sequence keeps it until the new snapshot lands.
  const state = bucket.id === sequenceId ? bucket.state : EMPTY_RUN_STATE;
  const stateRef = useRef(state);

  const publish = (next: SequenceRunState): void => {
    const stored = { id: sequenceId, state: next };
    stateRef.current = next;
    setBucket(stored);
  };

  const { status } = useRealtime({
    channels: [sequenceId],
    events: ['generation.run:started', 'generation.run:ended'],
    enabled: Boolean(sequenceId),
    onData: (message) => {
      if (message.event === 'generation.run:started') {
        publish(
          applyRunEvent(stateRef.current, {
            type: 'started',
            run: message.data,
          })
        );
        return;
      }
      publish(
        applyRunEvent(stateRef.current, {
          type: 'ended',
          instanceId: message.data.instanceId,
        })
      );
    },
  });

  useEffect(() => {
    if (!sequenceId) {
      stateRef.current = EMPTY_RUN_STATE;
      setBucket({ id: undefined, state: EMPTY_RUN_STATE });
      return;
    }
    if (status !== 'connected') return;
    let cancelled = false;
    // `state` is empty when the sequence just changed, and the previous
    // list when this is a reconnect. Later events go through `publish`.
    stateRef.current = state;
    publish(beginRunSnapshot(state));
    void getChannelRunsFn({ data: { channel: sequenceId } })
      .then((runs) => {
        if (cancelled) return;
        publish(applyRunRead(stateRef.current, runs));
      })
      .catch(() => {
        if (cancelled) return;
        publish(applyRunRead(stateRef.current, null));
      });
    return () => {
      cancelled = true;
    };
    // `state` is the list to snapshot and `publish` writes it. A new run
    // must not refetch, so neither is a dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sequenceId]);

  return state.runs;
}
