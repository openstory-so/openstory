import {
  GENERATION_STAGE_META,
  GENERATION_STAGES,
} from '@/lib/generation/pipeline';
import type { GenerationStage } from '@/lib/generation/pipeline';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { FC } from 'react';

type GenerationStopSliderProps = {
  value: GenerationStage;
  onChange: (stage: GenerationStage) => void;
  /** Continue-from: the thumb cannot move earlier than this stage. */
  minStage?: GenerationStage;
  disabled?: boolean;
};

const LAST_STOP = GENERATION_STAGES.length - 1;

function stopLabelPercent(index: number): number {
  return LAST_STOP === 0 ? 0 : (index / LAST_STOP) * 100;
}

export const GenerationStopSlider: FC<GenerationStopSliderProps> = ({
  value,
  onChange,
  minStage,
  disabled = false,
}) => {
  const minIndex = minStage ? GENERATION_STAGES.indexOf(minStage) : 0;
  const valueIndex = GENERATION_STAGES.indexOf(value);
  const clampedIndex = Math.max(minIndex, valueIndex);
  const selected = GENERATION_STAGES[clampedIndex] ?? 'script';

  return (
    <section
      className="@container flex flex-col gap-3"
      aria-labelledby="generation-stop-label"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3
          id="generation-stop-label"
          className="text-sm font-medium text-foreground"
        >
          Run until
        </h3>
        <span className="text-sm text-muted-foreground">
          {GENERATION_STAGE_META[selected].shortName}
        </span>
      </div>
      <Slider
        min={0}
        max={LAST_STOP}
        step={1}
        value={[clampedIndex]}
        disabled={disabled}
        onValueChange={(next) => {
          const index = next[0];
          if (index === undefined) return;
          const stage = GENERATION_STAGES[Math.max(minIndex, index)];
          if (stage) onChange(stage);
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
          {GENERATION_STAGES.map((stage, index) => (
            <button
              key={stage}
              type="button"
              disabled={disabled || index < minIndex}
              onClick={() => {
                if (index < minIndex) return;
                onChange(stage);
              }}
              className={cn(
                'absolute top-0 -translate-x-1/2 text-[11px] tracking-wide whitespace-nowrap',
                index <= clampedIndex
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground/40',
                index < minIndex && 'cursor-not-allowed opacity-50',
                index !== clampedIndex && '@max-[17rem]:hidden'
              )}
              style={{ left: `${stopLabelPercent(index)}%` }}
            >
              {GENERATION_STAGE_META[stage].shortName}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {GENERATION_STAGE_META[selected].description}. You can continue from
        here later.
      </p>
    </section>
  );
};
