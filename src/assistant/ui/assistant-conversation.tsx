/**
 * One thread (#2155): the virtualised message list over `useChat`, the
 * approvals bound to their tool cards, and the composer. Owns the chat so
 * the panel shell can swap threads by key.
 */

import type { ConnectionAdapter } from '@tanstack/ai-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/shadcn/button';
import type { PageContextItem } from '../page-context';
import { AssistantComposer } from './assistant-composer';
import { AssistantMessage } from './assistant-message';
import { useAssistantChat } from './use-assistant-chat';

export type AssistantConversationProps = {
  threadId: string;
  pageContext: PageContextItem[];
  onDismissContext: (item: PageContextItem) => void;
  initialPrompt?: string;
  /** Changes with each hand-over so the composer remounts with the text. */
  draftKey?: string;
  /** Three starters for an empty thread; the page decides them. */
  suggestions: string[];
  connection?: ConnectionAdapter;
  uploadStub?: (file: File) => Promise<string>;
};

export const AssistantConversation: React.FC<AssistantConversationProps> = ({
  threadId,
  pageContext,
  onDismissContext,
  initialPrompt,
  draftKey,
  suggestions,
  connection,
  uploadStub,
}) => {
  const queryClient = useQueryClient();
  const chat = useAssistantChat({ threadId, pageContext, connection });
  const {
    messages,
    sendMessage,
    isLoading,
    error,
    stop,
    addToolApprovalResponse,
  } = chat;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => messages[index]?.id ?? index,
  });

  // Bound approvals, by tool call, so the card that asked carries its buttons.
  // Answered by approval id, which the tool-call part carries: the server
  // tools are not registered on the client, so the typed `interrupts` list
  // cannot narrow to them.
  const approvals = {
    approve: (approvalId: string) =>
      void addToolApprovalResponse({ id: approvalId, approved: true }),
    deny: (approvalId: string) =>
      void addToolApprovalResponse({ id: approvalId, approved: false }),
  };

  const lastId = messages.at(-1)?.id;
  const items = virtualizer.getVirtualItems();
  // A new reply or a growing one keeps the end in view unless the user has
  // scrolled up to read; `scrollToIndex` on the last item is a no-op when
  // the list is already there.
  const follow = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearEnd && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col justify-end gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Ask about your work, or tell me what to change. I can read and edit
            anything the app can, and I ask before spending credits.
          </p>
          <ul className="flex flex-col gap-1" aria-label="Suggested prompts">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto w-full justify-start whitespace-normal py-1.5 text-left"
                  onClick={() => void sendMessage(suggestion)}
                >
                  {suggestion}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          role="log"
          aria-live="polite"
          aria-busy={isLoading}
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => {
              const message = messages[item.index];
              if (!message) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={(node) => {
                    virtualizer.measureElement(node);
                    if (node && message.id === lastId) follow();
                  }}
                  className="absolute left-0 top-0 w-full px-4 py-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <AssistantMessage
                    message={message}
                    streaming={isLoading && message.id === lastId}
                    approvals={approvals}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="border-t px-4 py-2 text-xs text-destructive">
          {error.message}
        </p>
      )}
      <AssistantComposer
        key={`${threadId}:${draftKey ?? ''}`}
        context={pageContext}
        onDismissContext={onDismissContext}
        initialPrompt={initialPrompt}
        busy={isLoading}
        onSend={(content) => {
          void sendMessage(content);
          // The first send creates the thread row; History should list it.
          if (messages.length === 0) {
            void queryClient.invalidateQueries({
              queryKey: ['assistant-threads'],
            });
          }
        }}
        onStop={stop}
        uploadStub={uploadStub}
      />
    </div>
  );
};
