import { getSequenceHistoryFn } from '@/sequences/history.fn';
import type {
  HistoryEntry,
  HistoryLink,
} from '@/sequences/server/db/sequence-events';
import { Button } from '@/ui/shadcn/button';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Link } from '@tanstack/react-router';
import { useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { VList } from 'virtua';

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

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const when = new Date(entry.createdAt).toLocaleString();
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">{entry.summary}</p>
        <time
          dateTime={entry.createdAt}
          title={when}
          className="shrink-0 text-sm text-muted-foreground tabular-nums"
        >
          {relativeTime(entry.createdAt)}
        </time>
      </div>
      <p className="flex flex-wrap items-baseline gap-2 text-sm text-muted-foreground">
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

export function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export function HistoryPage({ sequenceId }: { sequenceId: string }) {
  const history = useSuspenseInfiniteQuery({
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
  const events = history.data.pages.flatMap((page) => page.events);

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has happened yet.
        </p>
      ) : (
        <div className="min-h-0 flex-1">
          <VList style={{ height: '100%' }}>
            {events.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} />
            ))}
          </VList>
        </div>
      )}
      {history.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={history.isFetchingNextPage}
          onClick={() => {
            void history.fetchNextPage();
          }}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </Button>
      ) : null}
    </div>
  );
}
