/** `POST /api/v1/gateway/chat/{model}`: one platform-key text run, held and charged like every in-process call (#2437). */

import type { GatewayChatBody } from '@/gateway/chat-schema';
import {
  getMaxOutputTokens,
  isValidAnalysisModelId,
} from '@/models/models.config';
import { createAdapter } from '@/models/server/create-adapter';
import { chatModelOptionsForCall } from '@/models/server/llm-call-helper';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { chat, toServerSentEventsResponse } from '@tanstack/ai';

export async function streamGatewayChat(
  scopedDb: {
    readonly apiKeys: Pick<ScopedDb['apiKeys'], 'resolvePlatformLlmKey'>;
  },
  model: string,
  body: GatewayChatBody,
  oauthClientId: string | null
): Promise<Response> {
  if (!isValidAnalysisModelId(model)) throw new NotFoundError('Unknown model');
  const ceiling = getMaxOutputTokens(model, 1);
  if (body.maxTokens > ceiling) {
    throw new ValidationError(`maxTokens is above this model's ${ceiling}`);
  }
  // Platform keys only, so every run is billed; a model the card cannot price is refused, never run direct.
  const key = await scopedDb.apiKeys.resolvePlatformLlmKey(
    model,
    oauthClientId
  );
  // The public API charges the card only: a model it cannot price is refused, never run direct.
  if (!key || !('card' in key.meter) || !key.meter.card) {
    throw new ValidationError('This model cannot be priced yet');
  }
  const abortController = new AbortController();
  const stream = chat({
    adapter: createAdapter(model, key),
    messages: body.messages,
    ...(body.system && { systemPrompts: [body.system] }),
    modelOptions: chatModelOptionsForCall(model, key, false, body.maxTokens),
    threadId: generateId(),
    abortController,
  });
  return toServerSentEventsResponse(stream, { abortController });
}
