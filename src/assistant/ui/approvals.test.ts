import { ChatClient, type ChatInterrupt } from '@tanstack/ai-client';
import { describe, expect, it } from 'vitest';
import { asStub } from '@/test/as-stub';
import {
  answerOpenApproval,
  approvalFor,
  approvalState,
  composerHold,
} from './approvals';
import { scriptedConnection } from './scripted-connection';

const deleteShot = () =>
  scriptedConnection({
    charsPerSecond: 100_000,
    steps: [
      {
        toolCalls: [
          {
            name: 'openstory_delete_shot',
            input: { shotId: '01J0SHOT' },
            needsApproval: true,
            result: { deleted: true },
            delayMs: 0,
          },
        ],
      },
      { text: 'Deleted.' },
    ],
  });

const toolCallId = (client: ChatClient) => {
  for (const part of client.getMessages().flatMap((m) => m.parts)) {
    if (part.type === 'tool-call') return part.id;
  }
  throw new Error('no tool call');
};

const busy = (client: ChatClient) =>
  client.getIsLoading() || client.getInterruptState().resuming;

const settled = async (client: ChatClient) => {
  for (let i = 0; i < 200; i++) {
    if (client.getInterrupts().length === 0 && !busy(client)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not settle');
};

const toolResults = (client: ChatClient) =>
  client
    .getMessages()
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'tool-result');

const interrupt = (fields: {
  toolCallId?: string;
  binding?: unknown;
  canResolve?: boolean;
  status?: ChatInterrupt['status'];
  kind?: string;
}) =>
  asStub<ChatInterrupt>({
    kind: fields.kind ?? 'generic',
    canResolve: fields.canResolve ?? true,
    status: fields.status ?? 'pending',
    errors: [],
    metadata: {
      'tanstack:interruptBinding':
        'binding' in fields
          ? fields.binding
          : { kind: 'tool-approval', toolCallId: fields.toolCallId },
    },
    resolveInterrupt: () => undefined,
  });

describe('assistant approvals', () => {
  it('finds a server tool approval by its card and resumes the run on Allow', async () => {
    const client = new ChatClient({
      threadId: 'thread_1',
      connection: deleteShot(),
    });
    await client.sendMessage('Delete shot 3');

    const interrupts = client.getInterrupts();
    // Pins the library's shape: a server tool is not registered here, so it is not `tool-approval`.
    expect(interrupts.map((i) => i.kind)).toEqual(['generic']);
    const id = toolCallId(client);
    expect(approvalState(approvalFor(interrupts, id), false)).toBe('open');
    expect(composerHold(interrupts, false)).toBe('approval');
    await expect(client.sendMessage('hello')).rejects.toThrow(
      /pending interrupts/
    );

    expect(answerOpenApproval(interrupts, id, busy(client), true)).toBe(true);
    await settled(client);

    expect(client.getInterruptState().interruptErrors).toEqual([]);
    expect(
      toolResults(client).some((p) =>
        JSON.stringify(p.content).includes('deleted')
      )
    ).toBe(true);
    expect(
      client
        .getMessages()
        .flatMap((m) => m.parts)
        .some((p) => p.type === 'text' && p.content === 'Deleted.')
    ).toBe(true);
    expect(composerHold(client.getInterrupts(), false)).toBe('none');
  });

  it('sends a denial as a denied result', async () => {
    const client = new ChatClient({
      threadId: 'thread_1',
      connection: deleteShot(),
    });
    await client.sendMessage('Delete shot 3');
    expect(
      answerOpenApproval(
        client.getInterrupts(),
        toolCallId(client),
        busy(client),
        false
      )
    ).toBe(true);
    await settled(client);

    const [result] = toolResults(client);
    expect(result?.type === 'tool-result' && result.outcome).toBe('denied');
  });

  it('sends one answer when Allow is clicked twice', async () => {
    const client = new ChatClient({
      threadId: 'thread_1',
      connection: deleteShot(),
    });
    await client.sendMessage('Delete shot 3');
    const id = toolCallId(client);

    const first = answerOpenApproval(
      client.getInterrupts(),
      id,
      busy(client),
      true
    );
    const second = answerOpenApproval(
      client.getInterrupts(),
      id,
      busy(client),
      true
    );
    await settled(client);

    expect([first, second]).toEqual([true, false]);
    expect(toolResults(client)).toHaveLength(1);
  });

  it('shows a staged answer as waiting on the other card', () => {
    expect(
      approvalState(interrupt({ toolCallId: 'a', status: 'staged' }), false)
    ).toBe('staged');
    expect(
      answerOpenApproval(
        [interrupt({ toolCallId: 'a', status: 'staged' })],
        'a',
        false,
        true
      )
    ).toBe(false);
  });

  it('reopens a failed answer for another try', () => {
    expect(
      approvalState(interrupt({ toolCallId: 'a', status: 'error' }), false)
    ).toBe('open');
  });

  it('holds the composer as stuck on an interrupt no card can answer', () => {
    const unanswerable = [
      interrupt({ toolCallId: 'a', canResolve: false }),
      interrupt({ binding: undefined }),
      interrupt({ binding: { kind: 'generic', toolCallId: 'a' } }),
      interrupt({ binding: { kind: 'tool-approval', toolCallId: 7 } }),
    ];
    for (const i of unanswerable) {
      expect(composerHold([i], false)).toBe('stuck');
    }
    expect(approvalState(unanswerable[0], false)).toBe('stuck');
    expect(approvalFor(unanswerable.slice(1), 'a')).toBeUndefined();
  });

  it('refuses to answer an approval that is not a generic interrupt', () => {
    expect(() =>
      answerOpenApproval(
        [interrupt({ toolCallId: 'a', kind: 'tool-approval' })],
        'a',
        false,
        true
      )
    ).toThrow(/tool-approval interrupt/);
  });

  it('has nothing to answer for a card with no interrupt', () => {
    expect(approvalFor([], 'call_1')).toBeUndefined();
    expect(approvalState(undefined, false)).toBe('gone');
    expect(approvalState(undefined, true)).toBe('busy');
    expect(composerHold([], false)).toBe('none');
    expect(composerHold([], true)).toBe('approval');
  });
});
