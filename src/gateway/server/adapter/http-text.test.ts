/** Text on the hosted gateway: plain text streams on the install's key, nothing held or charged here, the rest refused (#2438). */

import { describe, expect, it, vi } from 'vitest';

const KEY = `osk_${'k'.repeat(64)}`;
const env: Record<string, string | undefined> = {
  OPENSTORY_API_KEY: KEY,
  OPENSTORY_GATEWAY_URL: 'https://hosted.example',
};
vi.doMock('#env', () => ({ getEnv: () => env }));

const { chat, toolDefinition } = await import('@tanstack/ai');
const { z } = await import('zod');
const { hostedTextAdapter } = await import('./http-text');

const MODEL = 'anthropic/claude-haiku-4.5';

/** What the hosted endpoint writes: its own `chat()` stream as SSE, split mid-event. */
const FINISHED = {
  type: 'RUN_FINISHED',
  runId: 'r1',
  threadId: 't1',
  finishReason: 'stop',
  timestamp: 2,
};

function hostedStream(
  events: readonly object[] = [
    {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'Hello',
      timestamp: 1,
    },
    FINISHED,
  ]
): Response {
  const wire = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 20));
        controller.enqueue(bytes.slice(20));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

function hosted(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response();
    })
  );
  return calls;
}

const text = (body: string) => ({
  adapter: hostedTextAdapter(MODEL),
  threadId: 't1',
  messages: [{ role: 'user' as const, content: body }],
  systemPrompts: ['Be brief.'],
  modelOptions: { max_tokens: 16 },
});

describe('hosted text', () => {
  it('streams a plain text call from the hosted endpoint on the install key', async () => {
    const calls = hosted(hostedStream);
    let answer = '';
    for await (const chunk of chat({ ...text('Hi'), stream: true })) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') answer += chunk.delta;
    }
    expect(answer).toBe('Hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://hosted.example/api/v1/gateway/chat/anthropic/claude-haiku-4.5'
    );
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(
      `Bearer ${KEY}`
    );
    expect(JSON.parse(z.string().parse(calls[0]?.init.body))).toEqual({
      messages: [{ role: 'user', content: 'Hi' }],
      system: 'Be brief.',
      maxTokens: 16,
    });
  });

  it('surfaces the hosted refusal unchanged', async () => {
    hosted(() =>
      Response.json(
        {
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'Not enough credits',
          },
        },
        { status: 402 }
      )
    );
    await expect(chat({ ...text('Hi'), stream: false })).rejects.toThrow(
      'The hosted gateway refused this call (INSUFFICIENT_CREDITS: Not enough credits)'
    );
  });

  it('refuses tools and images before sending anything', async () => {
    const calls = hosted(hostedStream);
    await expect(
      chat({
        ...text('Hi'),
        stream: false,
        tools: [
          toolDefinition({
            name: 'look',
            description: 'Look',
            inputSchema: z.object({}),
          }).server(async () => ({})),
        ],
      })
    ).rejects.toThrow('A call with tools cannot run on the hosted gateway');
    await expect(
      chat({
        ...text('Hi'),
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', value: 'https://x/a.png' },
              },
            ],
          },
        ],
      })
    ).rejects.toThrow('An image, file or empty turn cannot run');
    expect(calls).toHaveLength(0);
  });

  it('runs structured output on the hosted endpoint: the schema goes in the body, the parsed object comes back', async () => {
    const calls = hosted(() =>
      hostedStream([
        {
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: 'm1',
          delta: '{"name":"Mara"}',
          timestamp: 1,
        },
        {
          type: 'CUSTOM',
          name: 'structured-output.complete',
          value: { object: { name: 'Mara' }, raw: '{"name":"Mara"}' },
          timestamp: 2,
        },
        FINISHED,
      ])
    );
    const result = await chat({
      ...text('Name the baker'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', content: 'Name' },
            { type: 'text', content: 'the baker' },
          ],
        },
      ],
      outputSchema: z.object({ name: z.string() }),
    });
    expect(result).toEqual({ name: 'Mara' });
    const sent = JSON.parse(z.string().parse(calls[0]?.init.body));
    expect(sent.messages).toEqual([
      { role: 'user', content: 'Name\nthe baker' },
    ]);
    expect(sent.outputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    expect(sent.maxTokens).toBe(16);
  });

  it("surfaces the hosted provider's schema refusal unchanged", async () => {
    hosted(() =>
      hostedStream([
        {
          type: 'RUN_ERROR',
          runId: 'r1',
          message: 'Provider refused the output schema: unsupported keyword',
          timestamp: 1,
        },
      ])
    );
    await expect(
      chat({ ...text('Hi'), outputSchema: z.object({ name: z.string() }) })
    ).rejects.toThrow(
      'Provider refused the output schema: unsupported keyword'
    );
  });
});
