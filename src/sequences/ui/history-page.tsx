import { getSequenceHistoryFn } from '@/sequences/history.fn';
import { mediaModelName } from '@/sequences/model-label';
import type { HistoryChange } from '@/sequences/history-changes';
import type {
  HistoryEntry,
  HistoryLink,
  HistoryPreview,
} from '@/sequences/server/db/sequence-events';
import { PromptDiffView } from '@/shots/ui/prompts/prompt-diff-view';
import { AppImage } from '@/ui/shadcn/app-image';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { cn } from '@/ui/utils';
import { Link } from '@tanstack/react-router';
import { useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

const linkClass =
  'rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function TargetLink({ label, link }: { label: string; link: HistoryLink }) {
  if (link.to === '/sequences/$id/scenes') {
    return (
      <Link
        to={link.to}
        params={link.params}
        search={link.search}
        className={linkClass}
      >
        {label}
      </Link>
    );
  }
  if (link.to === '/sequences/$id/cast/$characterId') {
    return (
      <Link to={link.to} params={link.params} className={linkClass}>
        {label}
      </Link>
    );
  }
  if (link.to === '/sequences/$id/locations/$locationId') {
    return (
      <Link to={link.to} params={link.params} className={linkClass}>
        {label}
      </Link>
    );
  }
  return (
    <Link to={link.to} params={link.params} className={linkClass}>
      {label}
    </Link>
  );
}

function ChangeDiff({ change }: { change: HistoryChange }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{change.label}</span>
      {change.to === null ? (
        <p className="text-sm text-muted-foreground">
          <del>{change.from}</del>
        </p>
      ) : (
        <PromptDiffView before={change.from} after={change.to} />
      )}
    </div>
  );
}

function StillThumb({ preview }: { preview: HistoryPreview }) {
  return (
    <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md bg-muted">
      <AppImage
        src={preview.url}
        alt=""
        width={96}
        height={64}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function HistoryStills({ entry }: { entry: HistoryEntry }) {
  const current = entry.preview;
  const previous = entry.previousPreview;
  const shown = current ?? previous;
  if (!shown) return null;
  const model = mediaModelName(shown.model);
  return (
    <div className="flex items-center gap-2">
      {previous ? <StillThumb preview={previous} /> : null}
      {current ? <StillThumb preview={current} /> : null}
      <span className="min-w-0 truncate text-sm">{model}</span>
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const when = new Date(entry.createdAt).toLocaleString();
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">{entry.summary}</p>
        <time
          dateTime={entry.createdAt}
          title={when}
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {relativeTime(entry.createdAt)}
        </time>
      </div>
      <HistoryStills entry={entry} />
      {entry.changes.length > 0 ? (
        <div className="flex flex-col gap-2">
          {entry.changes.map((change, index) => (
            <ChangeDiff key={`${change.label}-${index}`} change={change} />
          ))}
        </div>
      ) : null}
      <p className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
        <span>{entry.actorName}</span>
        {entry.link ? (
          <TargetLink label={entry.targetLabel} link={entry.link} />
        ) : (
          <span>{entry.targetLabel}</span>
        )}
      </p>
    </div>
  );
}

function useHistory(sequenceId: string) {
  return useSuspenseInfiniteQuery({
    queryKey: ['sequence-history', sequenceId],
    queryFn: ({ pageParam }) =>
      getSequenceHistoryFn({
        data: {
          sequenceId,
          ...(pageParam ? { before: pageParam } : {}),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

function HistoryList({
  history,
  className,
}: {
  history: ReturnType<typeof useHistory>;
  className?: string;
}) {
  const events = history.data.pages.flatMap((page) => page.events);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div
      ref={scrollRef}
      className={cn('min-h-0 flex-1 overflow-y-auto', className)}
    >
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has happened yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
          <div ref={sentinelRef} className="h-px" aria-hidden />
          {isFetchingNextPage ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/** The log filling the inspector column once History is open. */
export function HistoryColumn({ sequenceId }: { sequenceId: string }) {
  const history = useHistory(sequenceId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HistoryList history={history} className="px-4 py-3" />
    </div>
  );
}

export function HistoryPage({ sequenceId }: { sequenceId: string }) {
  const history = useHistory(sequenceId);
  return (
    <div className="flex h-full flex-col p-6">
      <HistoryList history={history} />
    </div>
  );
}
