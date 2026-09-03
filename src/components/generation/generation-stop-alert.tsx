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
  /** Start frames on/off rides with the stop-at: off hides the Images stop. */
  generateStartFrames: boolean;
  remember: boolean;
  onConfirm: (next: {
    stopAt: GenerationStage;
    generateStartFrames: boolean;
    remember: boolean;
  }) => void;
  /** Extra copy — e.g. Generate Copy warning. */
  description?: string;
  confirmLabel?: string;
  /** Cost of a run that stops at the given stage in the given mode. */
  estimateForStopAt?: (
    stage: GenerationStage,
    generateStartFrames: boolean
  ) => Microdollars | null;
};

export const GenerationStopAlert: FC<GenerationStopAlertProps> = ({
  open,
  onOpenChange,
  stopAt,
  generateStartFrames,
  remember,
  onConfirm,
  description,
  confirmLabel = 'Generate',
  estimateForStopAt,
}) => {
  const [draftStopAt, setDraftStopAt] = useState(stopAt);
  const [draftStartFrames, setDraftStartFrames] = useState(generateStartFrames);
  const [draftRemember, setDraftRemember] = useState(remember);

  useEffect(() => {
    if (!open) return;
    setDraftStopAt(stopAt);
    setDraftStartFrames(generateStartFrames);
    setDraftRemember(remember);
  }, [open, stopAt, generateStartFrames, remember]);

  const estimate = estimateForStopAt?.(draftStopAt, draftStartFrames) ?? null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>How much control do you want?</AlertDialogTitle>
          <AlertDialogDescription>
            {description ??
              'The workflow stops at the stage you pick. You can generate the rest from the scene list.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <GenerationStopSlider
          value={draftStopAt}
          onChange={setDraftStopAt}
          generateStartFrames={draftStartFrames}
          onGenerateStartFramesChange={setDraftStartFrames}
        />
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
        <AlertDialogFooter className="sm:items-start">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Cost sits under the CTA, as under every other generate button. */}
          <div className="flex flex-col gap-1">
            <AlertDialogAction
              onClick={() =>
                onConfirm({
                  stopAt: draftStopAt,
                  generateStartFrames: draftStartFrames,
                  remember: draftRemember,
                })
              }
            >
              {confirmLabel}
            </AlertDialogAction>
            <div className="min-h-4">
              <ActionCost estimate={estimate} align="end" />
            </div>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
