import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { analyzeManualSequenceFn } from '../manual-sequence.fn';
import { sequenceKeys, useSequence } from './use-sequences';
import { shotKeys } from '@/shots/ui/use-shots';
import { sceneKeys } from '@/shots/ui/use-scenes';

export function AnalyzeManualSequenceButton({
  sequenceId,
  disabled,
  sceneId,
}: {
  sequenceId: string;
  disabled: boolean;
  sceneId?: string;
}) {
  const label = sceneId ? 'Determine shots' : 'Scan for characters';
  const [open, setOpen] = useState(false);
  const { data: sequence } = useSequence(sequenceId);
  const queryClient = useQueryClient();
  const analyze = useMutation({
    mutationFn: () =>
      analyzeManualSequenceFn({
        data: sceneId
          ? { sequenceId, sceneId, action: 'shots' }
          : { sequenceId, action: 'characters' },
      }),
    onSuccess: async () => {
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        queryClient.invalidateQueries({ queryKey: sceneKeys.list(sequenceId) }),
      ]);
      toast.success(sceneId ? 'Determining shots' : 'Scanning for characters');
    },
    onError: (error) =>
      toast.error('Could not analyze script', { description: error.message }),
  });
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled || sequence?.status === 'processing' || analyze.isPending
        }
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" />
        {label}…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {sceneId
                ? 'Suggest and add shots for this scene using its saved script and your sequence settings. Existing shots and media are preserved.'
                : 'Scan the saved scene scripts and add newly found characters. Existing characters and shots are preserved.'}{' '}
              Save script edits before starting.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={analyze.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={analyze.isPending}
              onClick={() => analyze.mutate()}
            >
              {analyze.isPending ? 'Starting…' : label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
