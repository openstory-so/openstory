import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { useGenerateVariants, useSelectVariant } from '@/hooks/use-shots';
import type { TextToImageModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ShotView } from '@/lib/shots/shot-view';
import { Grid2x2, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { hasUpscaleOverlay, UpscaleOverlay } from './upscale-overlay';
import { VariantSelector } from './variant-selector';

type StartingFrameVariantsProps = {
  shot: ShotView;
  sequenceId: string;
  /** Scene-level image model (#909) the variants are generated with. */
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
  /** Optimistic generating flag shared with the rest of the app (#882). */
  generating: boolean;
  onGenerateStart: () => void;
};

/**
 * A "Variants" control overlaid on the starting frame (#986). Replaces the old
 * Variants tab: the button lives on the canvas image, and clicking it opens a
 * dialog with the variant grid so the alternates have room to display at full
 * aspect ratio. Selecting a tile promotes it to the shot's starting frame.
 */
export const StartingFrameVariants: React.FC<StartingFrameVariantsProps> = ({
  shot,
  sequenceId,
  imageModel,
  aspectRatio,
  generating,
  onGenerateStart,
}) => {
  const [open, setOpen] = useState(false);
  const generateVariants = useGenerateVariants();
  const selectVariant = useSelectVariant();
  const { needsBillingSetup: falNeedsBillingSetup, showGate: showFalGate } =
    useFalBillingGate();

  const isGeneratingGrid =
    generating ||
    shot.gridSheet?.status === 'generating' ||
    generateVariants.isPending;
  const upscalingIndex = shot.pendingUpscaleIndex;
  const isUpscaling =
    hasUpscaleOverlay({
      gridUrl: shot.gridSheet?.url,
      variantIndex: upscalingIndex,
      cropUrl: shot.pendingUpscaleUrl,
    }) || selectVariant.isPending;

  const handleGenerate = useCallback(async () => {
    onGenerateStart();
    try {
      await generateVariants.mutateAsync({
        sequenceId,
        shotId: shot.id,
        model: imageModel,
      });
    } catch (error) {
      toast.error('Scene variants generation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [onGenerateStart, generateVariants, sequenceId, shot.id, imageModel]);

  const handleSelect = useCallback(
    async (index: number) => {
      // Start the mutation first: onMutate writes the overlay synchronously.
      // Then close. Closing before that await lets React paint the old still.
      const run = selectVariant.mutateAsync({
        sequenceId,
        shotId: shot.id,
        variantIndex: index,
      });
      setOpen(false);
      try {
        await run;
      } catch (error) {
        toast.error('Failed to select variant', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    [selectVariant, sequenceId, shot.id]
  );

  return (
    <>
      <UpscaleOverlay
        aspectRatio={aspectRatio}
        gridUrl={shot.gridSheet?.url}
        variantIndex={upscalingIndex}
        cropUrl={shot.pendingUpscaleUrl}
        className="z-[6]"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="absolute top-2 left-2 z-10 h-8 gap-1.5 bg-black/50 px-2 text-xs text-white hover:bg-black/70"
        aria-label={isUpscaling ? 'Upscaling frame variant' : 'Frame variants'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={isUpscaling || isGeneratingGrid}
      >
        {isGeneratingGrid || isUpscaling ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Grid2x2 className="h-4 w-4" />
        )}
        {isUpscaling
          ? 'Upscaling…'
          : isGeneratingGrid
            ? 'Generating…'
            : 'Frame variants'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Frame variants</DialogTitle>
            <DialogDescription>
              Pick an alternate for this shot&apos;s starting frame, or generate
              a new set.
            </DialogDescription>
          </DialogHeader>

          {shot.gridSheet?.url ? (
            <VariantSelector
              variantImageUrl={shot.gridSheet.url}
              selectedVariantIndex={upscalingIndex}
              onVariantSelect={(index) => void handleSelect(index)}
              loading={isUpscaling}
              disabled={isGeneratingGrid}
              aspectRatio={aspectRatio}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-muted-foreground/30 p-6 text-center text-sm text-muted-foreground">
              No variants yet. Generate options for this starting frame.
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (falNeedsBillingSetup) {
                  showFalGate();
                  return;
                }
                void handleGenerate();
              }}
              disabled={isGeneratingGrid}
              className="w-full sm:w-auto"
            >
              {isGeneratingGrid && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGeneratingGrid
                ? 'Generating…'
                : shot.gridSheet?.url
                  ? 'Regenerate frame variants'
                  : 'Generate frame variants'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
