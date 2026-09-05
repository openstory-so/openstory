import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useCallback, useEffect, useReducer } from 'react';
import { z } from 'zod';
import { useRealtime } from './client';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'realtime', 'use-shot-prompt-stream']);

export type ShotPromptKind = 'visual' | 'motion';

const historyPayloadSchema = z.object({
  promptType: z.enum(['visual', 'motion']),
  delta: z.string().optional(),
  error: z.string().optional(),
});

type ShotPromptStreamStatus =
  | 'idle'
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed';

type PerPromptState = {
  text: string;
  status: ShotPromptStreamStatus;
  error?: string;
};

type ShotPromptStreamState = {
  visual: PerPromptState;
  motion: PerPromptState;
};

const initialPerPrompt: PerPromptState = { text: '', status: 'idle' };

const initialState: ShotPromptStreamState = {
  visual: initialPerPrompt,
  motion: initialPerPrompt,
};

type Action =
  | { type: 'PENDING'; promptType: ShotPromptKind }
  | { type: 'DELTA'; promptType: ShotPromptKind; delta: string }
  | { type: 'COMPLETED'; promptType: ShotPromptKind }
  | { type: 'FAILED'; promptType: ShotPromptKind; error: string }
  | { type: 'RESET' };

/**
 * A delta arriving after a terminal state (`completed` / `failed`) means a
 * fresh regeneration just started — reset the accumulated text so the
 * textarea doesn't carry over the previous run's prompt.
 */
function reducePromptState(
  state: PerPromptState,
  action: Extract<Action, { promptType: ShotPromptKind }>
): PerPromptState {
  switch (action.type) {
    case 'PENDING':
      // Caller-driven: the mutation enqueued a workflow and we're waiting for
      // the first realtime delta. Clears any prior run's text so the textarea
      // doesn't display the previous prompt during the gap.
      return { text: '', status: 'pending', error: undefined };
    case 'DELTA':
      if (state.status === 'streaming') {
        return { ...state, text: state.text + action.delta };
      }
      return { text: action.delta, status: 'streaming', error: undefined };
    case 'COMPLETED':
      return { ...state, status: 'completed', error: undefined };
    case 'FAILED':
      return { ...state, status: 'failed', error: action.error };
  }
}

function reducer(
  state: ShotPromptStreamState,
  action: Action
): ShotPromptStreamState {
  if (action.type === 'RESET') return initialState;
  return {
    ...state,
    [action.promptType]: reducePromptState(state[action.promptType], action),
  };
}

/**
 * Subscribe to a shot's per-shot prompt-regen realtime channel and surface
 * the live-streaming text plus terminal status for each prompt type.
 *
 * The hook is gated on `enabled` so we only pay realtime + history-fetch
 * costs while the shot is actually being viewed — unsubscribe on nav-away.
 * On re-mount, channel history replays via `getChannelHistoryFn`, rebuilding
 * the streaming text (or terminal state) as if the user had been on the
 * shot the whole time.
 */
export function useShotPromptStream(
  shotId: string | undefined,
  enabled: boolean = true
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { data: user } = useUser();
  const channelId = shotId ? `shot-prompt:${shotId}` : undefined;
  const active = enabled && Boolean(channelId);
  const canReplayHistory = active && Boolean(user);

  // Replay history on mount so a user who navigates back mid-regen sees the
  // accumulated text and the right status. Re-keys on shotId so switching
  // shots clears and re-fetches.
  useEffect(() => {
    if (!canReplayHistory || !channelId) {
      dispatch({ type: 'RESET' });
      return;
    }
    dispatch({ type: 'RESET' });
    let cancelled = false;
    getChannelHistoryFn({ data: { channel: channelId } })
      .then((events: { event: string; data: string }[]) => {
        if (cancelled) return;
        for (const evt of events) {
          const result = historyPayloadSchema.safeParse(JSON.parse(evt.data));
          if (!result.success) {
            logger.error(`Invalid history event "${evt.event}":`, {
              data: result.error,
            });
            continue;
          }
          const parsed = result.data;
          if (
            evt.event === 'shotPrompt.streaming' &&
            typeof parsed.delta === 'string'
          ) {
            dispatch({
              type: 'DELTA',
              promptType: parsed.promptType,
              delta: parsed.delta,
            });
          } else if (evt.event === 'shotPrompt.completed') {
            dispatch({ type: 'COMPLETED', promptType: parsed.promptType });
          } else if (
            evt.event === 'shotPrompt.failed' &&
            typeof parsed.error === 'string'
          ) {
            dispatch({
              type: 'FAILED',
              promptType: parsed.promptType,
              error: parsed.error,
            });
          }
        }
      })
      .catch((error: Error) => {
        logger.error(`Failed to fetch history for "${channelId}":`, {
          err: error,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [canReplayHistory, channelId]);

  const handleEvent = useCallback(
    (msg: {
      event: string;
      data: { promptType?: ShotPromptKind; delta?: string; error?: string };
    }) => {
      const { event, data } = msg;
      if (!data.promptType) return;
      if (event === 'shotPrompt.streaming' && typeof data.delta === 'string') {
        dispatch({
          type: 'DELTA',
          promptType: data.promptType,
          delta: data.delta,
        });
      } else if (event === 'shotPrompt.completed') {
        dispatch({ type: 'COMPLETED', promptType: data.promptType });
      } else if (
        event === 'shotPrompt.failed' &&
        typeof data.error === 'string'
      ) {
        dispatch({
          type: 'FAILED',
          promptType: data.promptType,
          error: data.error,
        });
      }
    },
    []
  );

  useRealtime({
    channels: channelId ? [channelId] : [],
    events: [
      'shotPrompt.streaming',
      'shotPrompt.completed',
      'shotPrompt.failed',
    ] as const,
    onData: handleEvent,
    enabled: active,
  });

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);
  const markPending = useCallback(
    (promptType: ShotPromptKind) => dispatch({ type: 'PENDING', promptType }),
    []
  );

  return { state, reset, markPending };
}
