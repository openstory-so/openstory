import { ActionCost } from '@/components/billing/action-cost';
import { GenerationStopSlider } from '@/components/generation/generation-stop-slider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { Microdollars } from '@/lib/billing/money';
import { type GenerationStage } from '@/lib/generation/pipeline';
import { useEffect, useState, type FC } from 'react';

type GenerationStopAlertProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopAt: GenerationStage;
  remember: boolean;
  onConfirm: (next: { stopAt: GenerationStage; remember: boolean }) => void;
  /** Extra copy — e.g. Generate Copy warning. */
  description?: string;
  confirmLabel?: string;
  /** Cost of a run that stops at the given stage. */
  estimateForStopAt?: (stage: GenerationStage) => Microdollars | null;
};

export const GenerationStopAlert: FC<GenerationStopAlertProps> = ({
  open,
  onOpenChange,
  stopAt,
  remember,
  onConfirm,
  description,
  confirmLabel = 'Generate',
  estimateForStopAt,
}) => {
  const [draftStopAt, setDraftStopAt] = useState(stopAt);
  const [draftRemember, setDraftRemember] = useState(remember);

  useEffect(() => {
    if (!open) return;
    setDraftStopAt(stopAt);
    setDraftRemember(remember);
  }, [open, stopAt, remember]);

  const estimate = estimateForStopAt?.(draftStopAt) ?? null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>How far should this run?</AlertDialogTitle>
          <AlertDialogDescription>
            {description ??
              'The workflow stops at the stage you pick. You can generate the rest from the scene list.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <GenerationStopSlider value={draftStopAt} onChange={setDraftStopAt} />
        <div className="flex items-center gap-2">
          <Checkbox
            id="remember-generation-stop"
            checked={draftRemember}
            onCheckedChange={(checked) => setDraftRemember(checked === true)}
          />
          <Label
            htmlFor="remember-generation-stop"
            className="text-sm font-normal text-muted-foreground"
          >
            Remember my choice
          </Label>
        </div>
        <div className="min-h-4 flex justify-end">
          <ActionCost estimate={estimate} align="end" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              onConfirm({ stopAt: draftStopAt, remember: draftRemember })
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
