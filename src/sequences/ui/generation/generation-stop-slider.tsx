import {
  continueOffersStartFramesSwitch,
  continueOffersVoicesSwitch,
  GENERATION_STAGE_META,
  sliderStages,
  sliderTickLabel,
  sliderThumbIndex,
  stopAfterSentence,
  stopAtFromSliderIndex,
} from '@/sequences/pipeline';
import type { GenerationStage } from '@/sequences/pipeline';
import { VOICE_DESIGN_COST } from '@/billing/elevenlabs-pricing';
import { microsToDisplayUsd } from '@/billing/money';
import { Label } from '@/ui/shadcn/label';
import { Slider } from '@/ui/shadcn/slider';
import { Switch } from '@/ui/shadcn/switch';
import { cn } from '@/ui/utils';
import { useEffect, type FC } from 'react';

type GenerationStopSliderProps = {
  value: GenerationStage;
  onChange: (stage: GenerationStage) => void;
  /** Continue-from: the thumb cannot move earlier than this stage. */
  minStage?: GenerationStage;
  /**
   * Render a still per shot before motion. Off = reference-only, which has no
   * Images stop. Pass `onGenerateStartFramesChange` to offer the switch.
   * Continue (`minStage`) hides it once Images has already finished.
   */
  generateStartFrames?: boolean;
  onGenerateStartFramesChange?: (value: boolean) => void;
  /** Design a voice per speaking character (#1553); offered like start frames. */
  generateVoices?: boolean;
  onGenerateVoicesChange?: (value: boolean) => void;
  disabled?: boolean;
};

function stopLabelPercent(index: number, lastStop: number): number {
  return lastStop === 0 ? 0 : (index / lastStop) * 100;
}

export const GenerationStopSlider: FC<GenerationStopSliderProps> = ({
  value,
  onChange,
  minStage,
  generateStartFrames = true,
  onGenerateStartFramesChange,
  generateVoices = false,
  onGenerateVoicesChange,
  disabled = false,
}) => {
  const stages = sliderStages(!generateStartFrames, generateVoices);
  const lastStop = stages.length - 1;
  const minIndex = minStage ? sliderThumbIndex(minStage, stages) : 0;
  const clampedIndex = Math.max(minIndex, sliderThumbIndex(value, stages));
  const selected = stopAtFromSliderIndex(clampedIndex, stages);
  const combinedStillsAndDialogue = generateStartFrames && generateVoices;
  // Images is not a slider stop when Voices is also on — promote so the
  // parent stores Dialogue (the combined tick) rather than a hidden Images.
  useEffect(() => {
    if (selected !== value) onChange(selected);
  }, [onChange, selected, value]);
  // Generate dialog has no minStage, so both switches stay if handlers are
  // passed. Continue keys off the sequence's actual next stage (not a
  // draft skip): turning start frames off must not hide the switches.
  const offerStartFrames =
    Boolean(onGenerateStartFramesChange) &&
    (minStage == null || continueOffersStartFramesSwitch(minStage));
  const offerVoices =
    Boolean(onGenerateVoicesChange) &&
    (minStage == null || continueOffersVoicesSwitch(minStage));

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="generation-stop-label"
    >
      <h3
        id="generation-stop-label"
        className="text-sm font-medium text-foreground"
      >
        {stopAfterSentence(selected, {
          generateStartFrames: combinedStillsAndDialogue,
        })}
      </h3>
      <Slider
        min={0}
        max={lastStop}
        step={1}
        value={[clampedIndex]}
        disabled={disabled}
        onValueChange={(next) => {
          const index = next[0];
          if (index === undefined) return;
          onChange(stopAtFromSliderIndex(Math.max(minIndex, index), stages));
        }}
        aria-label="How far generation should run"
      />
      {/*
        Radix insets each thumb by half its width so it stays on the track
        (`size-3` → 6px). Labels use the same inset, then sit on the stop
        percentages — not in equal flex cells, which centre between stops.
      */}
      <div className="px-1.5" aria-hidden="true">
        <div className="relative min-h-8">
          {stages.map((stage, index) => (
            <button
              key={stage}
              type="button"
              disabled={disabled || index < minIndex}
              onClick={() => {
                if (index < minIndex) return;
                onChange(stopAtFromSliderIndex(index, stages));
              }}
              className={cn(
                'absolute top-0 max-w-[6.5rem] text-[11px] leading-tight tracking-wide whitespace-pre-line line-clamp-2',
                index === 0
                  ? 'translate-x-0 text-left'
                  : index === lastStop
                    ? '-translate-x-full text-right'
                    : '-translate-x-1/2 text-center',
                index <= clampedIndex
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground/40',
                index < minIndex && 'cursor-not-allowed opacity-50'
              )}
              style={{ left: `${stopLabelPercent(index, lastStop)}%` }}
            >
              {/* Ticks name the stop; the heading above says what happens
                  there. The last tick used stopAfterSentence, so it repeated
                  the heading ("Don't stop") instead of naming the stage. */}
              {index === lastStop
                ? sliderTickLabel(stage)
                : stage === 'dialogue' && combinedStillsAndDialogue
                  ? sliderTickLabel('dialogue', { generateStartFrames: true })
                  : GENERATION_STAGE_META[stage].shortName}
            </button>
          ))}
        </div>
      </div>
      {offerStartFrames && onGenerateStartFramesChange && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="generate-start-frames"
              checked={generateStartFrames}
              onCheckedChange={(next) => {
                onGenerateStartFramesChange(next);
                // Off drops the Images stop; a thumb sitting on it moves up to
                // Motion & Music so the parent's value matches the slider.
                const nextStages = sliderStages(!next, generateVoices);
                const moved = stopAtFromSliderIndex(
                  sliderThumbIndex(value, nextStages),
                  nextStages
                );
                if (moved !== value) onChange(moved);
              }}
              disabled={disabled}
            />
            <Label htmlFor="generate-start-frames" className="text-sm">
              Use start frames
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {generateStartFrames
              ? 'Each shot’s video starts from a generated still.'
              : 'Video is generated straight from the reference sheets.'}
          </p>
        </div>
      )}
      {offerVoices && onGenerateVoicesChange && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="generate-voices"
              checked={generateVoices}
              onCheckedChange={(next) => {
                onGenerateVoicesChange(next);
                const nextStages = sliderStages(!generateStartFrames, next);
                const moved = stopAtFromSliderIndex(
                  sliderThumbIndex(value, nextStages),
                  nextStages
                );
                if (moved !== value) onChange(moved);
              }}
              disabled={disabled}
            />
            <Label htmlFor="generate-voices" className="text-sm">
              Voices
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {generateVoices
              ? `Each speaking character gets a designed voice (${microsToDisplayUsd(VOICE_DESIGN_COST)} each).`
              : 'Characters have no voice.'}
          </p>
        </div>
      )}
    </section>
  );
};
