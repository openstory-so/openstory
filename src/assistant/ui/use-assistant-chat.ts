/**
 * The assistant's `useChat` (#2155): one SSE connection to
 * /api/assistant/chat, server-authoritative history by thread id (a reload
 * or a second tab hydrates the same transcript and any paused approval),
 * and the page context forwarded with every send.
 */

import { fetchServerSentEvents, useChat } from '@tanstack/ai-react';
import type { ConnectionAdapter } from '@tanstack/ai-react';
import { useMemo } from 'react';
import type { AnalysisModelId } from '@/models/models.config';
import type { PageContextItem } from '../page-context';
import { startAssistantThread } from './assistant-store';

const ASSISTANT_CHAT_URL = '/api/assistant/chat';

/** The server's error envelope: `{ error: { code, message } }`. */
async function errorFromBody(response: Response): Promise<Error> {
  let code = '';
  let message = `Request failed (${response.status})`;
  try {
    const body: unknown = await response.clone().json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null
    ) {
      const { error } = body;
      if ('code' in error && typeof error.code === 'string') code = error.code;
      if ('message' in error && typeof error.message === 'string') {
        message = error.message;
      }
    }
  } catch {
    // not JSON; the status line stands
  }
  const error = new Error(message);
  error.name = code || 'AssistantRequestError';
  return error;
}

/**
 * The client library reports a non-OK response as its status line and
 * drops the body. This reads the server's message first (out of credits,
 * a refused upload) and, for a thread the browser kept from another
 * sign-in, starts a new one.
 */
async function fetchWithServerErrors(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const error = await errorFromBody(response);
  if (response.status === 404 && error.name === 'THREAD_NOT_FOUND') {
    startAssistantThread();
  }
  throw error;
}

export type AssistantChatOptions = {
  threadId: string;
  pageContext: PageContextItem[];
  model: AnalysisModelId;
  /** Stories and tests hand in a scripted connection. */
  connection?: ConnectionAdapter;
};

export function useAssistantChat({
  threadId,
  pageContext,
  model,
  connection,
}: AssistantChatOptions) {
  const live = useMemo(
    () =>
      connection ??
      fetchServerSentEvents(ASSISTANT_CHAT_URL, {
        fetchClient: fetchWithServerErrors,
      }),
    [connection]
  );
  return useChat({
    connection: live,
    threadId,
    persistence: true,
    forwardedProps: { pageContext, model },
  });
}
