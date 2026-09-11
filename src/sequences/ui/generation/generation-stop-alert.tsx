import { ActionCost } from '@/billing/ui/action-cost';
import { GenerationStopSlider } from './generation-stop-slider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import { Checkbox } from '@/ui/shadcn/checkbox';
import {
  useDraftGenerationEstimate,
  type DraftGenerationEstimateInput,
} from '@/sequences/ui/use-draft-generation-estimate';
import type { GenerationStage } from '@/sequences/pipeline';
import { useEffect, useState, type FC } from 'react';

type GenerationStopAlertProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopAt: GenerationStage;
  /** Start frames on/off rides with the stop-at: off hides the Images stop. */
  generateStartFrames: boolean;
  /** Design a voice per speaking character (#1553). */
  generateVoices: boolean;
  remember: boolean;
  onConfirm: (next: {
    stopAt: GenerationStage;
    generateStartFrames: boolean;
    generateVoices: boolean;
    remember: boolean;
  }) => void;
  /** Extra copy — e.g. Generate Copy warning. */
  description?: string;
  confirmLabel?: string;
  /** Shared with the Generate footer so slider ticks reuse the same query. */
  estimateBase?: Omit<
    DraftGenerationEstimateInput,
    'stopAt' | 'generateStartFrames'
  > | null;
};

export const GenerationStopAlert: FC<GenerationStopAlertProps> = ({
  open,
  onOpenChange,
  stopAt,
  generateStartFrames,
  generateVoices,
  remember,
  onConfirm,
  description,
  confirmLabel = 'Generate',
  estimateBase,
}) => {
  const [draftStopAt, setDraftStopAt] = useState(stopAt);
  const [draftStartFrames, setDraftStartFrames] = useState(generateStartFrames);
  const [draftVoices, setDraftVoices] = useState(generateVoices);
  const [draftRemember, setDraftRemember] = useState(remember);

  useEffect(() => {
    if (!open) return;
    setDraftStopAt(stopAt);
    setDraftStartFrames(generateStartFrames);
    setDraftVoices(generateVoices);
    setDraftRemember(remember);
  }, [open, stopAt, generateStartFrames, generateVoices, remember]);

  const estimate = useDraftGenerationEstimate(
    open && estimateBase
      ? {
          ...estimateBase,
          stopAt: draftStopAt,
          generateStartFrames: draftStartFrames,
        }
      : null
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Generate the whole sequence?</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <GenerationStopSlider
          value={draftStopAt}
          onChange={setDraftStopAt}
          generateStartFrames={draftStartFrames}
          onGenerateStartFramesChange={setDraftStartFrames}
          generateVoices={draftVoices}
          onGenerateVoicesChange={setDraftVoices}
        />
        <AlertDialogFooter className="sm:items-start">
          {/* "Don't ask again" lives in the button bar, opposite the buttons,
              as it does in native dialogs. */}
          <label
            htmlFor="remember-generation-stop"
            className="flex h-9 items-center gap-2 text-sm text-muted-foreground sm:mr-auto"
          >
            <Checkbox
              id="remember-generation-stop"
              checked={draftRemember}
              onCheckedChange={(checked) => setDraftRemember(checked === true)}
            />
            Don't ask again
          </label>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Cost sits under the CTA, as under every other generate button. */}
          <div className="flex flex-col gap-1">
            <AlertDialogAction
              onClick={() =>
                onConfirm({
                  stopAt: draftStopAt,
                  generateStartFrames: draftStartFrames,
                  generateVoices: draftVoices,
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
