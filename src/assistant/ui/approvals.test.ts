import { ChatClient } from '@tanstack/ai-client';
import { describe, expect, it } from 'vitest';
import { answerApproval, approvalFor, approvalState } from './approvals';
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

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('assistant approvals', () => {
  it('finds a server tool approval by its card and resumes the run on Allow', async () => {
    const client = new ChatClient({
      threadId: 'thread_1',
      connection: deleteShot(),
    });
    await client.sendMessage('Delete shot 3');

    const interrupts = client.getInterrupts();
    // The server tool is not registered on the client, so it is not a `tool-approval`.
    expect(interrupts.map((i) => i.kind)).toEqual(['generic']);
    const approval = approvalFor(interrupts, toolCallId(client));
    expect(approval).toBeDefined();
    expect(approvalState(approval, false)).toBe('open');
    await expect(client.sendMessage('hello')).rejects.toThrow(
      /pending interrupts/
    );

    if (!approval) return;
    answerApproval(approval, true);
    await until(
      () => client.getInterrupts().length === 0 && !client.getIsLoading()
    );

    const parts = client.getMessages().flatMap((m) => m.parts);
    expect(client.getInterruptState().interruptErrors).toEqual([]);
    expect(
      parts.some(
        (p) =>
          p.type === 'tool-result' &&
          JSON.stringify(p.content).includes('deleted')
      )
    ).toBe(true);
    expect(
      parts.some((p) => p.type === 'text' && p.content === 'Deleted.')
    ).toBe(true);
  });

  it('sends a denial as a denied result', async () => {
    const client = new ChatClient({
      threadId: 'thread_1',
      connection: deleteShot(),
    });
    await client.sendMessage('Delete shot 3');
    const approval = approvalFor(client.getInterrupts(), toolCallId(client));
    if (!approval) throw new Error('no approval');
    answerApproval(approval, false);
    await until(
      () => client.getInterrupts().length === 0 && !client.getIsLoading()
    );

    const result = client
      .getMessages()
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-result');
    expect(result?.type === 'tool-result' && result.outcome).toBe('denied');
  });

  it('has nothing to answer for a card with no interrupt', () => {
    expect(approvalFor([], 'call_1')).toBeUndefined();
    expect(approvalState(undefined, false)).toBe('gone');
    expect(approvalState(undefined, true)).toBe('busy');
  });
});
