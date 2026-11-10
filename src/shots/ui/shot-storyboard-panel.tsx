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

/**
 * A reference-only shot's storyboard (#2350): its sketch, whether it is
 * stale, and Regenerate. Past sketches are in the shot's History.
 */
export const ShotStoryboardPanel: React.FC<PanelProps> = (props) => (
  <Suspense
    fallback={
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-16 w-24" />
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
            : data.staleReason === 'failed'
              ? `${STALE_COPY.failed} ${data.history[0]?.error ?? ''}`.trim()
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

      {data.current?.url ? (
        <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md bg-muted">
          <AppImage
            src={data.current.url}
            alt="Current storyboard sketch"
            width={96}
            height={64}
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}
    </div>
  );
};
