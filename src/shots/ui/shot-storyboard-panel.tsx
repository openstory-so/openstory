import { Suspense } from 'react';
import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { useFalBillingGate } from '@/billing/ui/use-billing-gate';
import { errorMessage } from '@/platform/errors';
import {
  getShotStoryboardFn,
  regenerateShotStoryboardFn,
} from '@/shots/shot-storyboard.fn';
import { AppImage } from '@/ui/shadcn/app-image';
import { Button } from '@/ui/shadcn/button';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useHydrated } from '@/ui/use-hydrated';

type PanelProps = { sequenceId: string; shotId: string };

/** Under ['shots', sequenceId], so a landed sketch's realtime invalidation reaches it. */
export const storyboardQuery = (sequenceId: string, shotId: string) =>
  queryOptions({
    queryKey: ['shots', sequenceId, 'storyboard', shotId],
    queryFn: () => getShotStoryboardFn({ data: { sequenceId, shotId } }),
    refetchInterval: (query) => (query.state.data?.generating ? 3000 : false),
  });

const STALE_COPY = {
  missing: 'No sketch yet.',
  failed: 'The last redraw failed.',
  changed: 'The prompt or cast changed since this sketch.',
} as const;

const DATE = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * A reference-only shot's storyboard (#2350): whether its sketch is stale,
 * Regenerate, and every sketch drawn for it. The newest always shows.
 */
export const ShotStoryboardPanel: React.FC<PanelProps> = (props) => (
  <Suspense
    fallback={
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="aspect-video w-full" />
      </div>
    }
  >
    <StoryboardBody {...props} />
  </Suspense>
);

const StoryboardBody: React.FC<PanelProps> = ({ sequenceId, shotId }) => {
  const queryClient = useQueryClient();
  const hydrated = useHydrated();
  const { needsBillingSetup, showGate } = useFalBillingGate();
  const { data } = useSuspenseQuery(storyboardQuery(sequenceId, shotId));
  const regenerate = useMutation({
    mutationFn: () =>
      regenerateShotStoryboardFn({ data: { sequenceId, shotId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['shots', sequenceId] }),
    onError: (error) =>
      toast.error('Sketch did not start', {
        description: errorMessage(error),
      }),
  });
  const drawing = data.generating || regenerate.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {drawing
            ? 'Drawing a new sketch…'
            : data.staleReason
              ? STALE_COPY[data.staleReason]
              : 'Up to date with the prompt and cast.'}
        </p>
        <Button
          type="button"
          size="sm"
          variant={data.staleReason ? 'default' : 'outline'}
          disabled={!hydrated || drawing}
          onClick={() => {
            if (needsBillingSetup) {
              showGate();
              return;
            }
            regenerate.mutate();
          }}
        >
          {drawing ? 'Drawing…' : 'Regenerate'}
        </Button>
      </div>

      {data.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sketches appear here once drawn.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3" aria-label="Sketch history">
          {data.history.map((sketch) => (
            <li key={sketch.id} className="flex flex-col gap-1">
              {sketch.url ? (
                <AppImage
                  src={sketch.url}
                  alt={`Sketch from ${DATE.format(new Date(sketch.createdAt))}`}
                  width={320}
                  height={180}
                  className="aspect-video w-full rounded-md bg-muted object-contain"
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
                  {sketch.status === 'failed'
                    ? (sketch.error ?? 'Failed')
                    : 'Drawing…'}
                </div>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {`${sketch.id === data.current?.id ? 'Showing · ' : ''}${DATE.format(new Date(sketch.createdAt))}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
