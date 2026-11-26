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
function hostedStream(): Response {
  const events = [
    {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'Hello',
      timestamp: 1,
    },
    {
      type: 'RUN_FINISHED',
      runId: 'r1',
      threadId: 't1',
      finishReason: 'stop',
      timestamp: 2,
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(events);
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

  it('refuses tools, structured output and images before sending anything', async () => {
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
    await expect(
      chat({ ...text('Hi'), outputSchema: z.object({ a: z.string() }) })
    ).rejects.toThrow('Structured output cannot run on the hosted gateway');
    expect(calls).toHaveLength(0);
  });
});
