/**
 * Lip-sync a finished clip to its dialogue (#2263). One shot, or every
 * qualifying shot of a scene. The server refuses a packed clip, a missing
 * recording, or a clip already generating.
 */

import { InButtonCost } from '@/billing/ui/action-cost';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import { estimateLipsyncCost } from '@/motion/lipsync';
import { lipsyncSceneFn, lipsyncShotFn } from '@/motion/lipsync.fn';
import { shotKeys } from '@/shots/ui/use-shots';
import { Button } from '@/ui/shadcn/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

function durationEstimate(durationMs: number | null): Microdollars {
  return estimateLipsyncCost((durationMs ?? 0) / 1000);
}

function invalidateLipsync(
  queryClient: ReturnType<typeof useQueryClient>,
  sequenceId: string,
  shotIds: readonly string[]
): void {
  void queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) });
  for (const shotId of shotIds) {
    void queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) });
    void queryClient.invalidateQueries({
      queryKey: shotKeys.videoVersions(shotId),
    });
  }
}

export const LipsyncShotButton: React.FC<{
  sequenceId: string;
  shotId: string;
  durationMs: number | null;
}> = ({ sequenceId, shotId, durationMs }) => {
  const queryClient = useQueryClient();
  const lipsync = useMutation({
    mutationFn: () => lipsyncShotFn({ data: { sequenceId, shotId } }),
    onSuccess: () => invalidateLipsync(queryClient, sequenceId, [shotId]),
    onError: (error: Error) =>
      toast.error('Lip-sync did not start', { description: error.message }),
  });
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={lipsync.isPending}
      onClick={() => lipsync.mutate()}
    >
      <InButtonCost estimate={durationEstimate(durationMs)} onPrimary={false}>
        {lipsync.isPending ? 'Lip-syncing…' : 'Lip-sync'}
      </InButtonCost>
    </Button>
  );
};

export const LipsyncSceneButton: React.FC<{
  sequenceId: string;
  shots: readonly { id: string; durationMs: number | null }[];
  label: string;
}> = ({ sequenceId, shots, label }) => {
  const queryClient = useQueryClient();
  const estimate = shots.reduce(
    (total, shot) => addMicros(total, durationEstimate(shot.durationMs)),
    ZERO_MICROS
  );
  const lipsync = useMutation({
    mutationFn: () =>
      lipsyncSceneFn({
        data: { sequenceId, shotIds: shots.map((shot) => shot.id) },
      }),
    onSuccess: (result) => {
      invalidateLipsync(
        queryClient,
        sequenceId,
        result.started.map((row) => row.shotId)
      );
      if (result.started.length === 0) {
        toast.error('Lip-sync did not start', {
          description: result.skipped.map((row) => row.reason).join(' '),
        });
        return;
      }
      if (result.skipped.length > 0) {
        toast.error('Some shots were not lip-synced', {
          description: result.skipped.map((row) => row.reason).join(' '),
        });
      }
    },
    onError: (error: Error) =>
      toast.error('Lip-sync did not start', { description: error.message }),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={shots.length === 0 || lipsync.isPending}
      aria-label={`Lip-sync all for ${label}`}
      onClick={() => lipsync.mutate()}
    >
      <InButtonCost estimate={estimate} onPrimary={false}>
        {lipsync.isPending ? 'Lip-syncing…' : 'Lip-sync all'}
      </InButtonCost>
    </Button>
  );
};
