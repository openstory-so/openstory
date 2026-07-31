import {
  getUpdateStaleShotsRunFn,
  updateStaleShotsFn,
} from '@/functions/shots';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { shotStalenessNamespace } from './use-shot-staleness';

/** How often the run's status is polled while it's in flight. */
const RUN_POLL_MS = 5_000;
/**
 * Backstop for a run we can never get a verdict on (an id that doesn't resolve
 * to a binding, or a status lookup that keeps failing). The workflow itself is
 * unaffected — this only stops the client polling forever.
 */
const RUN_DEADLINE_MS = 15 * 60_000;

/**
 * "Update all" (#1077) — enqueues the durable `UpdateStaleShotsWorkflow`
 * (shot / scene / sequence scope) and reports what it actually did.
 *
 * All orchestration is server-side. This hook:
 *
 *   1. fires the trigger mutation (a credits preflight there means an
 *      out-of-credits user gets the billing dialog rather than a run that
 *      silently regenerates nothing), then
 *   2. polls the run's terminal outcome, refreshing the staleness namespace
 *      each tick so indicators clear progressively, and
 *   3. on completion reports the result — including partial failures.
 *
 * Point 3 is the reason this polls the run rather than watching the staleness
 * map: the workflow isolates failures per shot, so it can finish `complete`
 * having regenerated nothing. Inferring "done" from indicators clearing can't
 * distinguish that from success — it just waits for artifacts that will never
 * change and then gives up quietly.
 */
export function useUpdateStaleShots(args: { sequenceId: string }) {
  const { sequenceId } = args;
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const deadlineRef = useRef(0);

  const trigger = useMutation({
    mutationFn: (vars: { sceneId?: string; shotId?: string }) =>
      updateStaleShotsFn({ data: { sequenceId, ...vars } }),
  });
  const { mutate: triggerMutate, isPending: triggerPending } = trigger;

  const run = useCallback(
    (vars: { sceneId?: string; shotId?: string }) => {
      if (triggerPending || runId) return;
      triggerMutate(
        { sceneId: vars.sceneId, shotId: vars.shotId },
        {
          onSuccess: ({ workflowRunId }) => {
            deadlineRef.current = Date.now() + RUN_DEADLINE_MS;
            setRunId(workflowRunId);
          },
          onError: (error) => {
            toast.error('Update failed to start', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [triggerPending, runId, triggerMutate]
  );

  const { data: outcome } = useQuery({
    queryKey: ['update-stale-shots-run', runId],
    queryFn: () => {
      if (!runId) throw new Error('runId required');
      return getUpdateStaleShotsRunFn({
        data: { sequenceId, workflowRunId: runId },
      });
    },
    enabled: !!runId,
    refetchInterval: RUN_POLL_MS,
    staleTime: 0,
  });

  // Refresh indicators on each tick so artifacts clear as they land, rather
  // than all at once when the run finishes.
  useEffect(() => {
    if (!runId) return;
    void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
  }, [outcome, runId, queryClient]);

  useEffect(() => {
    if (!runId || !outcome) return;

    if (outcome.state === 'running') {
      // Only give up on a run we can't get a verdict on; a genuinely
      // long-running one keeps its spinner.
      if (Date.now() > deadlineRef.current) {
        setRunId(null);
        toast.warning('Update is taking longer than expected', {
          description:
            'It may still be running. Check the indicators, or try again.',
        });
      }
      return;
    }

    if (outcome.state === 'failed') {
      setRunId(null);
      toast.error('Update failed', { description: outcome.error });
      return;
    }

    if (outcome.state === 'unknown') {
      // No verdict available (unresolvable run id, or the status lookup kept
      // failing). Say so rather than implying success.
      if (Date.now() > deadlineRef.current) {
        setRunId(null);
        toast.warning("Couldn't confirm the update finished", {
          description: 'Check the indicators to see what is still out of date.',
        });
      }
      return;
    }

    setRunId(null);
    const {
      totalShots,
      visualPrompts,
      motionPrompts,
      images,
      failures,
      skipped,
    } = outcome.result;
    const regenerated = visualPrompts + motionPrompts + images;

    if (failures.length > 0 || skipped.length > 0) {
      const problems = failures.length + skipped.length;
      toast.error(
        regenerated > 0
          ? `Updated ${regenerated} item${regenerated === 1 ? '' : 's'}, ${problems} could not be updated`
          : `Could not update ${problems} item${problems === 1 ? '' : 's'}`,
        {
          description:
            failures[0]?.error ??
            'Some shots were skipped because their state could not be determined.',
        }
      );
      return;
    }

    if (totalShots === 0) {
      toast.success('Everything is already up to date');
      return;
    }
    toast.success(
      `Updated ${regenerated} item${regenerated === 1 ? '' : 's'} across ${totalShots} shot${totalShots === 1 ? '' : 's'}`
    );
  }, [outcome, runId]);

  return { run, isRunning: triggerPending || runId !== null };
}
