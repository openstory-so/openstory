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

export const GenerationStopSlider: FC<GenerationStopSliderProps> = ({
  value,
  onChange,
  minStage,
  disabled = false,
}) => {
  const minIndex = minStage ? GENERATION_STAGES.indexOf(minStage) : 0;
  const valueIndex = GENERATION_STAGES.indexOf(value);
  const clampedIndex = Math.max(minIndex, valueIndex);

  return (
    <section
      className="flex flex-col gap-3"
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
          {
            GENERATION_STAGE_META[GENERATION_STAGES[clampedIndex] ?? 'images']
              .shortName
          }
        </span>
      </div>
      <Slider
        min={minIndex}
        max={GENERATION_STAGES.length - 1}
        step={1}
        value={[clampedIndex]}
        disabled={disabled}
        onValueChange={(next) => {
          const index = next[0];
          if (index === undefined) return;
          const stage = GENERATION_STAGES[index];
          if (stage) onChange(stage);
        }}
        aria-label="How far generation should run"
      />
      <div className="hidden gap-1 sm:flex" aria-hidden="true">
        {GENERATION_STAGES.map((stage, index) => (
          <button
            key={stage}
            type="button"
            disabled={disabled || index < minIndex}
            onClick={() => onChange(stage)}
            className={cn(
              'flex-1 text-center text-[11px] tracking-wide',
              index <= clampedIndex
                ? 'font-medium text-foreground'
                : 'text-muted-foreground/40',
              index < minIndex && 'cursor-not-allowed opacity-50'
            )}
          >
            {GENERATION_STAGE_META[stage].shortName}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {
          GENERATION_STAGE_META[GENERATION_STAGES[clampedIndex] ?? 'images']
            .description
        }
        . You can continue from here later.
      </p>
    </section>
  );
};
