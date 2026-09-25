import { shotStalenessNamespace } from '@/shots/ui/use-shot-staleness';
import { useHydrated } from '@/ui/use-hydrated';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, FilePlus2, Plus, Settings, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { Sequence } from '@/platform/server/db/schema';
import { Button } from '@/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { AspectRatioSelect } from '@/look/ui/aspect-ratio-select';
import { StyleSelectionDialogWithTrigger } from '@/look/ui/style-selection-dialog';
import { styleKeys, useStyles, useStyle } from '@/look/ui/use-styles';
import { ModelSelector } from '@/models/ui/pickers/model-selector';
import {
  DEFAULT_ANALYSIS_MODEL,
  isValidAnalysisModelId,
} from '@/models/models.config';
import { DEFAULT_ASPECT_RATIO } from '@/models/aspect-ratios';
import { DEFAULT_RESOLUTION } from '@/models/resolutions';
import {
  createBlankSequenceFn,
  saveSequenceSettingsFn,
} from '../manual-sequence.fn';
import { sequenceKeys } from './use-sequences';
import { UNTITLED_SEQUENCE_TITLE } from '../untitled-sequence-title';
import { shotKeys } from '@/shots/ui/use-shots';

export function ManualSequenceDialog({ sequence }: { sequence?: Sequence }) {
  const [open, setOpen] = useState(false);
  const hydrated = useHydrated();
  return (
    <>
      {sequence ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={!hydrated || sequence.status === 'processing'}
        >
          <Settings className="size-4" />
          Sequence settings
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="h-11 sm:h-10" disabled={!hydrated}>
              <Plus className="size-4" />
              New sequence
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem
              className="items-start gap-3 p-3"
              onSelect={() => setOpen(true)}
            >
              <FilePlus2 className="mt-0.5 size-4" />
              <span>
                <span className="block font-medium">New blank sequence</span>
                <span className="block text-xs text-muted-foreground">
                  Write and build scene by scene
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="items-start gap-3 p-3">
              <Link to="/">
                <Sparkles className="mt-0.5 size-4" />
                <span>
                  <span className="block font-medium">Generate with AI</span>
                  <span className="block text-xs text-muted-foreground">
                    Start from a prompt or script
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <ManualSequenceForm
            sequence={sequence}
            onClose={() => setOpen(false)}
          />
        )}
      </Dialog>
    </>
  );
}

function ManualSequenceForm({
  sequence,
  onClose,
}: {
  sequence?: Sequence;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: styles } = useStyles();
  const [title, setTitle] = useState(
    sequence?.title ?? UNTITLED_SEQUENCE_TITLE
  );
  const [styleId, setStyleId] = useState(sequence?.styleId ?? '');
  const { data: selectedStyle } = useStyle(styleId);
  const [aspectRatio, setAspectRatio] = useState(
    sequence?.aspectRatio ?? DEFAULT_ASPECT_RATIO
  );
  const [analysisModel, setAnalysisModel] = useState(
    sequence?.analysisModel && isValidAnalysisModelId(sequence.analysisModel)
      ? sequence.analysisModel
      : DEFAULT_ANALYSIS_MODEL
  );
  const save = useMutation({
    mutationFn: () => {
      const data = {
        title,
        styleId,
        aspectRatio,
        analysisModel,
        resolution: sequence?.resolution ?? DEFAULT_RESOLUTION,
      };
      return sequence
        ? saveSequenceSettingsFn({ data: { ...data, sequenceId: sequence.id } })
        : createBlankSequenceFn({ data });
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(sequenceKeys.detail(saved.id), saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
        queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() }),
        queryClient.invalidateQueries({
          queryKey: styleKeys.forSequence(saved.id),
        }),
        queryClient.invalidateQueries({ queryKey: shotKeys.list(saved.id) }),
      ]);
      onClose();
      if (!sequence)
        await navigate({
          to: '/sequences/$id/scenes',
          params: { id: saved.id },
          search: { view: 'script' },
        });
      else toast.success('Sequence settings saved');
    },
    onError: (error) =>
      toast.error('Could not save sequence', { description: error.message }),
  });
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          {sequence ? 'Sequence settings' : 'New blank sequence'}
        </DialogTitle>
        <DialogDescription>
          {sequence
            ? 'Settings apply to future generation. Existing media stays as it is.'
            : 'Build your sequence scene by scene. You can use AI whenever you choose.'}
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
        className="min-w-0 space-y-6"
      >
        <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="manual-sequence-title">Title</Label>
            <Input
              id="manual-sequence-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manual-sequence-style">Style</Label>
            <StyleSelectionDialogWithTrigger
              styles={styles}
              selectedStyle={selectedStyle}
              onStyleSelect={setStyleId}
              trigger={
                <Button
                  id="manual-sequence-style"
                  type="button"
                  variant="outline"
                  className="w-full min-w-0 justify-between"
                >
                  <span className="truncate">
                    {selectedStyle?.name ?? 'Select style'}
                  </span>
                  <ChevronDown className="size-4 shrink-0" />
                </Button>
              }
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label>Aspect ratio</Label>
            <AspectRatioSelect
              value={aspectRatio}
              onChange={setAspectRatio}
              className="w-full justify-start [&>svg:last-child]:ml-auto"
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label>Text model</Label>
            <ModelSelector
              selectedModels={[analysisModel]}
              onModelsChange={(models) => {
                if (models[0]) setAnalysisModel(models[0]);
              }}
              singleSelect
              disabled={save.isPending}
            />
          </div>
        </fieldset>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={save.isPending || !title.trim() || !styleId}
          >
            {save.isPending
              ? 'Saving…'
              : sequence
                ? 'Save settings'
                : 'Create blank sequence'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
