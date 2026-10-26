/**
 * The assistant's `useChat` (#2155): one SSE connection to
 * /api/assistant/chat, server-authoritative history by thread id (a reload
 * or a second tab hydrates the same transcript and any paused approval),
 * and the page context forwarded with every send.
 */

import { fetchServerSentEvents, useChat } from '@tanstack/ai-react';
import type { ConnectionAdapter } from '@tanstack/ai-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import type { AnalysisModelId } from '@/models/models.config';
import { PAGE_CONTEXT_NOUN, type PageContextItem } from '../page-context';
import {
  REPLACE_UNSAVED_TEXT,
  type ReplaceUnsavedTextInput,
} from '../unsaved-text-tool';
import { getAssistantState, startAssistantThread } from './assistant-store';

/**
 * The browser side of `replace_unsaved_text`: the server advertises the
 * definition when the page reports a draft; the page's `AssistantContextItem`
 * registered how to write into its editor. The id is always `draft`: a page
 * holds one draft of a kind.
 */
const replaceUnsavedText = {
  ...REPLACE_UNSAVED_TEXT,
  __toolSide: 'client' as const,
  execute: ({ kind, text }: ReplaceUnsavedTextInput) => {
    const replace = getAssistantState().draftEditors.get(`${kind}:draft`);
    if (!replace) {
      throw new Error(
        `There is no ${PAGE_CONTEXT_NOUN[kind].toLowerCase()} on this page any more.`
      );
    }
    replace(text);
    return { replaced: true, characters: text.length };
  },
};

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

/** A tool that changes something: anything but a read, whoami or the engine's own. */
function isWriteTool(name: string): boolean {
  return /^openstory_(?!get_|list_)/.test(name);
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
  const queryClient = useQueryClient();
  // A write the model made lands on the page the user is looking at: the
  // Images grid shows the asset generating, a shot its new prompt. Reads
  // change nothing, so they refetch nothing.
  const writes = useRef(new Set<string>());
  return useChat({
    connection: live,
    threadId,
    persistence: true,
    tools: [replaceUnsavedText],
    forwardedProps: { pageContext, model },
    onChunk: (chunk) => {
      if (chunk.type === 'TOOL_CALL_START' && isWriteTool(chunk.toolCallName)) {
        writes.current.add(chunk.toolCallId);
      } else if (
        chunk.type === 'TOOL_CALL_RESULT' &&
        writes.current.delete(chunk.toolCallId)
      ) {
        void queryClient.invalidateQueries();
      }
    },
  });
}
