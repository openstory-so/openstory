/**
 * One message in the thread (#2155). A user turn is a bubble on the right
 * with its attachments; an assistant turn is prose on the left, with each
 * tool call as a card where it happened. A tool result renders with its
 * call, never on its own.
 */

import type { MessagePart, ToolResultPart, UIMessage } from '@tanstack/ai';
import { Markdown } from '@tanstack/markdown/react';
import { cn } from '@/ui/utils';
import { ToolCallCard } from './tool-call-card';

/**
 * A link the model wrote: only http(s), opened in a new tab with the
 * destination visible next to it, so an injected link cannot pass for the
 * app's own. Any other scheme renders as text.
 */
function ModelLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  let url: URL | null = null;
  try {
    url = href ? new URL(href, window.location.origin) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return <span>{children}</span>;
  }
  const own = url.origin === window.location.origin;
  return (
    <a href={url.href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
      {!own && <span className="text-muted-foreground"> ({url.hostname})</span>}
    </a>
  );
}

/**
 * No remote images (a model-written image URL could carry data out) and
 * links through `ModelLink`.
 */
const MARKDOWN_COMPONENTS = { img: () => null, a: ModelLink };

export type ApprovalHandlers = {
  approve: (toolCallId: string) => void;
  deny: (toolCallId: string) => void;
};

/** The dollar estimate of the last plan in this message, if any. */
function planEstimate(parts: MessagePart[]): string | undefined {
  for (const part of [...parts].reverse()) {
    if (part.type !== 'tool-result' || typeof part.content !== 'string') {
      continue;
    }
    try {
      const data: unknown = JSON.parse(part.content);
      if (
        typeof data === 'object' &&
        data !== null &&
        'estimate' in data &&
        typeof data.estimate === 'object' &&
        data.estimate !== null &&
        'usd' in data.estimate
      ) {
        const usd = data.estimate.usd;
        return typeof usd === 'number' ? `$${usd.toFixed(2)}` : 'unknown';
      }
    } catch {
      // not JSON
    }
  }
  return undefined;
}

const UserPart: React.FC<{ part: MessagePart }> = ({ part }) => {
  if (part.type === 'text') {
    return <p className="whitespace-pre-wrap break-words">{part.content}</p>;
  }
  if (part.type === 'image' && part.source.type !== 'file') {
    const src =
      part.source.type === 'url'
        ? part.source.value
        : `data:${part.source.mimeType};base64,${part.source.value}`;
    return (
      <img
        src={src}
        alt="Attachment"
        width={160}
        height={120}
        className="h-auto max-h-40 w-auto max-w-full rounded-md object-cover"
      />
    );
  }
  return null;
};

export const AssistantMessage: React.FC<{
  message: UIMessage;
  streaming: boolean;
  approvals: ApprovalHandlers;
}> = ({ message, streaming, approvals }) => {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] flex-col gap-2 rounded-xl bg-muted px-3 py-2 text-sm">
          {message.parts.map((part, index) => (
            <UserPart key={index} part={part} />
          ))}
        </div>
      </div>
    );
  }
  if (message.role !== 'assistant') return null;
  const results = new Map<string, ToolResultPart>();
  for (const part of message.parts) {
    if (part.type === 'tool-result') results.set(part.toolCallId, part);
  }
  const estimate = planEstimate(message.parts);
  const hasText = message.parts.some(
    (part) => part.type === 'text' && part.content.length > 0
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          if (!part.content) return null;
          return (
            <div
              key={index}
              className="prose prose-sm dark:prose-invert max-w-none break-words"
            >
              <Markdown components={MARKDOWN_COMPONENTS}>
                {part.content}
              </Markdown>
            </div>
          );
        }
        if (part.type === 'tool-call') {
          return (
            <ToolCallCard
              key={part.id}
              part={part}
              result={results.get(part.id)}
              estimate={estimate}
              onApprove={() =>
                part.approval && approvals.approve(part.approval.id)
              }
              onDeny={() => part.approval && approvals.deny(part.approval.id)}
            />
          );
        }
        if (part.type === 'thinking' && streaming && !hasText) {
          return (
            <p key={index} className="text-xs text-muted-foreground">
              Thinking…
            </p>
          );
        }
        return null;
      })}
      {streaming && (
        <span
          className={cn('text-muted-foreground', hasText && 'sr-only')}
          aria-live="polite"
        >
          …
        </span>
      )}
    </div>
  );
};
