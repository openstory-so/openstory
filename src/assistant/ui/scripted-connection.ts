/**
 * A `ConnectionAdapter` for stories and tests (#2155): a scripted run that
 * speaks the same AG-UI events the server streams (text, tool calls, tool
 * results, tool errors, an approval interrupt), with no network and no
 * server. `@tanstack/ai` itself is server-only in this repo, so the events
 * are written by hand here.
 */

import type { StreamChunk } from '@tanstack/ai';
import type { ConnectionAdapter } from '@tanstack/ai-react';

type ScriptedToolCall = {
  name: string;
  input: Record<string, unknown>;
  /** What the tool returns; ignored when `error` is set. */
  result?: unknown;
  /** The tool fails with this message. */
  error?: string;
  /** The run pauses on this call until the user allows it. */
  needsApproval?: boolean;
  /** How long the tool "runs". */
  delayMs?: number;
};

type ScriptedStep = {
  text?: string;
  toolCalls?: ScriptedToolCall[];
};

export type ScriptedConnectionOptions = {
  /** One entry per model turn, in order; a tool call continues to the next. */
  steps: ScriptedStep[];
  /** Characters per second of the fake stream. */
  charsPerSecond?: number;
};

/** An event written by hand; `typed` hands it to the client as a chunk. */
type RawChunk = Record<string, unknown>;

async function* typed(
  source: AsyncIterable<RawChunk>
): AsyncGenerator<StreamChunk> {
  for await (const chunk of source) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a story harness: the type strings are the AG-UI enum's values, and `@tanstack/ai` (where the enum is re-exported) is server-only in this repo
    yield chunk as StreamChunk;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${++counter}`;

/**
 * Plays `steps` from `cursor` until a step has no tool calls or a call needs
 * approval. A resume continues after the approved call.
 */
type Cursor = {
  step: number;
  call: number;
  /** The call that paused the last run, answered first on resume. */
  pending?: { toolCallId: string; messageId: string; call: ScriptedToolCall };
};

async function* play(
  steps: ScriptedStep[],
  start: Cursor,
  ids: { threadId: string; runId: string },
  charsPerSecond: number,
  signal: AbortSignal | undefined,
  approved: boolean,
  onPause: (at: Cursor) => void
): AsyncGenerator<RawChunk> {
  const stamp = () => ({ timestamp: Date.now() });
  yield { type: 'RUN_STARTED', ...ids, ...stamp() };
  let step = start.step;
  let callIndex = start.call;
  if (start.pending) {
    const { toolCallId, messageId, call } = start.pending;
    if (approved) await sleep(call.delayMs ?? 600);
    yield {
      type: 'TOOL_CALL_RESULT',
      messageId,
      toolCallId,
      role: 'tool',
      content: approved
        ? JSON.stringify(call.result ?? {})
        : 'Error executing tool: the user denied this call',
      ...(approved
        ? {}
        : {
            metadata: {
              tanstack: { state: 'output-error', toolResultOutcome: 'denied' },
            },
          }),
      ...stamp(),
    };
  }
  while (step < steps.length) {
    const current = steps[step];
    if (!current) break;
    const messageId = nextId('msg');
    if (callIndex === 0 && current.text) {
      yield {
        type: 'TEXT_MESSAGE_START',
        messageId,
        role: 'assistant',
        ...stamp(),
      };
      const chunk = Math.max(1, Math.round(charsPerSecond / 20));
      for (let i = 0; i < current.text.length; i += chunk) {
        if (signal?.aborted) return;
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          messageId,
          delta: current.text.slice(i, i + chunk),
          ...stamp(),
        };
        await sleep(50);
      }
      yield { type: 'TEXT_MESSAGE_END', messageId, ...stamp() };
    }
    const calls = current.toolCalls ?? [];
    for (; callIndex < calls.length; callIndex++) {
      const call = calls[callIndex];
      if (!call) continue;
      const toolCallId = nextId('call');
      yield {
        type: 'TOOL_CALL_START',
        toolCallId,
        toolCallName: call.name,
        parentMessageId: messageId,
        ...stamp(),
      };
      yield {
        type: 'TOOL_CALL_ARGS',
        toolCallId,
        delta: JSON.stringify(call.input),
        ...stamp(),
      };
      yield { type: 'TOOL_CALL_END', toolCallId, ...stamp() };
      if (call.needsApproval) {
        onPause({
          step,
          call: callIndex + 1,
          pending: { toolCallId, messageId, call },
        });
        const interruptId = nextId('approval');
        yield {
          type: 'RUN_FINISHED',
          ...ids,
          ...stamp(),
          outcome: {
            type: 'interrupt',
            interrupts: [
              {
                id: interruptId,
                reason: 'tool_call',
                message: `Approval required to run ${call.name}`,
                toolCallId,
                responseSchema: {},
                metadata: {
                  kind: 'approval',
                  toolName: call.name,
                  input: call.input,
                  'tanstack:interruptBinding': {
                    v: 1,
                    kind: 'tool-approval',
                    interruptId,
                    interruptedRunId: ids.runId,
                    generation: 0,
                    toolName: call.name,
                    toolCallId,
                    originalArgs: call.input,
                    inputSchemaHash: '',
                    approvalSchemaHash: '',
                    responseSchemaHash: '',
                  },
                },
              },
            ],
          },
        };
        return;
      }
      await sleep(call.delayMs ?? 600);
      if (signal?.aborted) return;
      const failed = call.error !== undefined;
      yield {
        type: 'TOOL_CALL_RESULT',
        messageId,
        toolCallId,
        role: 'tool',
        content: failed
          ? `Error executing tool: ${call.error}`
          : JSON.stringify(call.result ?? {}),
        ...(failed
          ? { metadata: { tanstack: { state: 'output-error' } } }
          : {}),
        ...stamp(),
      };
    }
    callIndex = 0;
    step += 1;
    if (calls.length === 0) break;
  }
  onPause({ step, call: 0 });
  yield {
    type: 'RUN_FINISHED',
    ...ids,
    ...stamp(),
    outcome: { type: 'success' },
  };
}

export function scriptedConnection({
  steps,
  charsPerSecond = 120,
}: ScriptedConnectionOptions): ConnectionAdapter {
  let cursor: Cursor = { step: 0, call: 0 };
  return {
    connect: (_messages, _data, abortSignal, runContext) => {
      const ids = {
        threadId: runContext?.threadId ?? nextId('thread'),
        runId: runContext?.runId ?? nextId('run'),
      };
      // A resume carries the user's answer; a denial still plays the next
      // step so the story shows the model's reply to it.
      const approved = !JSON.stringify(runContext?.resume ?? []).includes(
        '"approved":false'
      );
      return typed(
        play(
          steps,
          cursor,
          ids,
          charsPerSecond,
          abortSignal,
          approved,
          (at) => {
            cursor = at;
          }
        )
      );
    },
    hydrate: async () => ({ messages: [], activeRun: null, interrupts: null }),
  };
}
