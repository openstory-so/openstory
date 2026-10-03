import { InButtonCost } from '@/billing/ui/action-cost';
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
import { includesStage } from '@/sequences/pipeline';
import type { GenerationStage } from '@/sequences/pipeline';
import { useEffect, useState, type FC } from 'react';

type GenerationStopAlertProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopAt: GenerationStage;
  /** Start frames on/off rides with the stop-at: off hides the Images stop. */
  generateStartFrames: boolean;
  /** The run records dialogue; a deployment fact, not a choice (#2004). */
  generateVoices: boolean;
  /** Draft first (#1756); the switch shows only when `offerDraftMotion`. */
  draftMotion: boolean;
  offerDraftMotion: boolean;
  remember: boolean;
  onConfirm: (next: {
    stopAt: GenerationStage;
    generateStartFrames: boolean;
    draftMotion: boolean;
    remember: boolean;
  }) => void;
  /** Extra copy — e.g. Generate Copy warning. */
  description?: string;
  confirmLabel?: string;
  /** Shared with the Generate footer so slider ticks reuse the same query. */
  estimateBase?: Omit<
    DraftGenerationEstimateInput,
    'stopAt' | 'generateStartFrames' | 'generateVoices' | 'draftMotion'
  > | null;
};

export const GenerationStopAlert: FC<GenerationStopAlertProps> = ({
  open,
  onOpenChange,
  stopAt,
  generateStartFrames,
  generateVoices,
  draftMotion,
  offerDraftMotion,
  remember,
  onConfirm,
  description,
  confirmLabel = 'Generate',
  estimateBase,
}) => {
  const [draftStopAt, setDraftStopAt] = useState(stopAt);
  const [draftStartFrames, setDraftStartFrames] = useState(generateStartFrames);
  const [draftDraftFirst, setDraftDraftFirst] = useState(draftMotion);
  const [draftRemember, setDraftRemember] = useState(remember);
  const draftFirst = offerDraftMotion && draftDraftFirst;

  useEffect(() => {
    if (!open) return;
    setDraftStopAt(stopAt);
    setDraftStartFrames(generateStartFrames);
    setDraftDraftFirst(draftMotion);
    setDraftRemember(remember);
  }, [open, stopAt, generateStartFrames, draftMotion, remember]);

  const estimate = useDraftGenerationEstimate(
    open && estimateBase
      ? {
          ...estimateBase,
          stopAt: draftStopAt,
          generateStartFrames: draftStartFrames,
          generateVoices,
          draftMotion: draftFirst,
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
          generateVoices={generateVoices}
          draftFirst={draftFirst}
          onDraftFirstChange={offerDraftMotion ? setDraftDraftFirst : undefined}
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
          <AlertDialogAction
            onClick={() =>
              onConfirm({
                stopAt: draftStopAt,
                generateStartFrames: draftStartFrames,
                draftMotion: draftDraftFirst,
                remember: draftRemember,
              })
            }
          >
            <InButtonCost
              estimate={estimate}
              amountWidth={
                includesStage(draftStopAt, 'motion') ? 'double' : 'single'
              }
            >
              {confirmLabel}
            </InButtonCost>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
