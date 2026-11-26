/**
 * An install's text call on the hosted gateway (#2438): `POST
 * /api/v1/gateway/chat/{model}`, paid by its `OPENSTORY_API_KEY` organization.
 * That endpoint takes text turns only, so tools, structured output and media
 * are refused here, never degraded.
 */

import { hostedFetch, hostedModelPath } from '@/gateway/server/remote-config';
import { requestMaxTokens } from '@/gateway/server/text';
import type { GatewayChatBody } from '@/gateway/chat-schema';
import type {
  AdapterYieldChunk,
  DefaultMessageMetadataByModality,
  TextOptions,
} from '@tanstack/ai';
import {
  BaseTextAdapter,
  type StructuredOutputOptions,
  type StructuredOutputResult,
} from '@tanstack/ai/adapters';

const NEEDS_LOCAL_KEY = 'set an OpenRouter or fal key on this install for it';

function refuse(what: string): never {
  throw new Error(
    `${what} cannot run on the hosted gateway yet: ${NEEDS_LOCAL_KEY}`
  );
}

/** The hosted endpoint's body, or a refusal naming what it cannot carry. */
function hostedChatBody(
  options: TextOptions<Record<string, unknown>>
): GatewayChatBody {
  if (options.tools?.length) refuse('A call with tools');
  const messages = options.messages.map((message) => {
    if (message.role === 'tool' || message.toolCalls?.length) {
      refuse('A tool turn');
    }
    if (typeof message.content !== 'string' || message.content === '') {
      refuse('An image, file or empty turn');
    }
    return { role: message.role, content: message.content };
  });
  const system = (options.systemPrompts ?? [])
    .map((prompt) => (typeof prompt === 'string' ? prompt : prompt.content))
    .join('\n\n');
  const maxTokens = requestMaxTokens(options.modelOptions);
  if (maxTokens === undefined) {
    throw new Error('A hosted gateway text call must set its output budget');
  }
  return { messages, ...(system && { system }), maxTokens };
}

function isChunk(value: unknown): value is AdapterYieldChunk {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

/** The hosted stream's events, as the hosted `chat()` wrote them. */
async function* readEvents(
  body: ReadableStream<Uint8Array>
): AsyncIterable<AdapterYieldChunk> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data: unknown = JSON.parse(line.slice('data: '.length));
        if (isChunk(data)) yield data;
      }
      end = buffer.indexOf('\n\n');
    }
  }
}

class HostedTextAdapter extends BaseTextAdapter<
  string,
  Record<string, unknown>,
  readonly ['text'],
  DefaultMessageMetadataByModality
> {
  readonly name = 'openstory';

  async *chatStream(
    options: TextOptions<Record<string, unknown>>
  ): AsyncIterable<AdapterYieldChunk> {
    const response = await hostedFetch(hostedModelPath('chat', this.model), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hostedChatBody(options)),
      signal: options.abortController?.signal,
    });
    if (!response.body) throw new Error('The hosted gateway sent no stream');
    yield* readEvents(response.body);
  }

  async structuredOutput(
    _options: StructuredOutputOptions<Record<string, unknown>>
  ): Promise<StructuredOutputResult<unknown>> {
    return refuse('Structured output');
  }
}

/** The text adapter for a model no key on this install can run. */
export function hostedTextAdapter(model: string): HostedTextAdapter {
  return new HostedTextAdapter(undefined, model);
}
