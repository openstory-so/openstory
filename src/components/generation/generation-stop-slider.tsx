import {
  GENERATION_STAGE_META,
  sliderStages,
  sliderStopDescription,
  sliderStopLabel,
  sliderThumbIndex,
  stopAtFromSliderIndex,
} from '@/lib/generation/pipeline';
import type { GenerationStage } from '@/lib/generation/pipeline';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { FC } from 'react';

type GenerationStopSliderProps = {
  value: GenerationStage;
  onChange: (stage: GenerationStage) => void;
  /** Continue-from: the thumb cannot move earlier than this stage. */
  minStage?: GenerationStage;
  /**
   * Render a still per shot before motion. Off = reference-only, which has no
   * Images stop. Pass `onGenerateStartFramesChange` to offer the switch; omit
   * it where the mode is already fixed (an existing sequence).
   */
  generateStartFrames?: boolean;
  onGenerateStartFramesChange?: (value: boolean) => void;
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
  disabled = false,
}) => {
  const stages = sliderStages(!generateStartFrames);
  const lastStop = stages.length - 1;
  const minIndex = minStage ? sliderThumbIndex(minStage, stages) : 0;
  const clampedIndex = Math.max(minIndex, sliderThumbIndex(value, stages));
  const selected = stopAtFromSliderIndex(clampedIndex, stages);

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="generation-stop-label"
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          id="generation-stop-label"
          className="text-sm font-medium text-foreground"
        >
          Stop after
        </h3>
        <span className="text-sm text-muted-foreground">
          {sliderStopLabel(selected)}
        </span>
      </div>
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
        <div className="relative h-5">
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
                'absolute top-0 text-[11px] tracking-wide whitespace-nowrap',
                index === 0
                  ? 'translate-x-0'
                  : index === lastStop
                    ? '-translate-x-full'
                    : '-translate-x-1/2',
                index <= clampedIndex
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground/40',
                index < minIndex && 'cursor-not-allowed opacity-50'
              )}
              style={{ left: `${stopLabelPercent(index, lastStop)}%` }}
            >
              {GENERATION_STAGE_META[stage].shortName}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {sliderStopDescription(selected)}.
      </p>
      {onGenerateStartFramesChange && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="generate-start-frames"
              checked={generateStartFrames}
              onCheckedChange={(next) => {
                onGenerateStartFramesChange(next);
                // Off drops the Images stop; a thumb sitting on it moves up to
                // Music & Motion so the parent's value matches the slider.
                const nextStages = sliderStages(!next);
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
            Renders a still for each shot to review before motion. Off renders
            video straight from the reference sheets.
          </p>
        </div>
      )}
    </section>
  );
};
