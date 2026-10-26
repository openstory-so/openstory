/**
 * One message in the thread (#2155). A user turn is a bubble on the right
 * with its attachments; an assistant turn is prose on the left, with each
 * tool call as a card where it happened. A tool result renders with its
 * call, never on its own.
 */

import type {
  MessagePart,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from '@tanstack/ai';
import { Markdown } from '@tanstack/markdown/react';
import { cn } from '@/ui/utils';
import {
  STATUS_LABEL,
  ToolCallCard,
  toolCardStatus,
  toolTitle,
  type ToolCardStatus,
} from './tool-call-card';

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

type Block =
  | { type: 'part'; part: MessagePart }
  | { type: 'tools'; calls: [ToolCallPart, ...ToolCallPart[]] };

/**
 * Consecutive tool calls become one block (a result part sits between its
 * call and the next and is rendered with the call, so it never breaks a
 * run). A run of two or more folds into `ToolCallGroup`.
 */
function groupToolCalls(parts: MessagePart[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.type === 'tool-result') continue;
    const last = blocks.at(-1);
    if (part.type === 'tool-call') {
      if (last?.type === 'tools') last.calls.push(part);
      else blocks.push({ type: 'tools', calls: [part] });
      continue;
    }
    blocks.push({ type: 'part', part });
  }
  return blocks;
}

/** "4 × Get scene, 2 × Update scene" */
function groupTitle(calls: ToolCallPart[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const title = toolTitle(call.name);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts]
    .map(([title, n]) => (n > 1 ? `${n} × ${title}` : title))
    .join(', ');
}

/**
 * A run of tool calls behind one `<details>`: open while any still runs or
 * waits on the user, shut once every one is done. The summary names the
 * calls and the worst status among them.
 */
const ToolCallGroup: React.FC<{
  calls: ToolCallPart[];
  results: Map<string, ToolResultPart>;
  children: React.ReactNode;
}> = ({ calls, results, children }) => {
  const statuses = calls.map((call) =>
    toolCardStatus(call, results.get(call.id))
  );
  const status: ToolCardStatus = statuses.includes('waiting')
    ? 'waiting'
    : statuses.includes('running')
      ? 'running'
      : statuses.includes('error')
        ? 'error'
        : 'done';
  const label =
    status === 'error'
      ? `${statuses.filter((s) => s === 'error').length} failed`
      : STATUS_LABEL[status];
  return (
    <details
      open={status !== 'done'}
      data-status={status}
      className={cn(
        'rounded-lg border bg-card',
        status === 'error' && 'border-destructive/40',
        status === 'waiting' && 'border-ring'
      )}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate font-medium">
          {calls.length} steps
          <span className="font-normal text-muted-foreground">
            {' · '}
            {groupTitle(calls)}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      </summary>
      <div className="flex flex-col gap-2 border-t p-2">{children}</div>
    </details>
  );
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
  /** Text a tool view posts into the thread. */
  onViewMessage?: (text: string) => void;
}> = ({ message, streaming, approvals, onViewMessage }) => {
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
  const card = (part: ToolCallPart) => (
    <ToolCallCard
      key={part.id}
      part={part}
      result={results.get(part.id)}
      estimate={estimate}
      onApprove={() => approvals.approve(part.id)}
      onDeny={() => approvals.deny(part.id)}
      onViewMessage={onViewMessage}
    />
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      {groupToolCalls(message.parts).map((block, index) => {
        if (block.type === 'tools') {
          const [first, ...rest] = block.calls;
          if (rest.length === 0) return card(first);
          return (
            <ToolCallGroup key={first.id} calls={block.calls} results={results}>
              {block.calls.map(card)}
            </ToolCallGroup>
          );
        }
        const { part } = block;
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
