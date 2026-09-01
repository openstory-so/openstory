import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { GenerationMode } from '@/lib/ai/generation-mode';
import { Gauge, Zap } from 'lucide-react';
import type { FC } from 'react';

type GenerationModeToggleProps = {
  value: GenerationMode;
  onChange: (mode: GenerationMode) => void;
  disabled?: boolean;
};

/**
 * Quality | Turbo switch. Lives next to Generate: it selects the
 * recommended default in each catalog. Pickers still show the full list,
 * grouped Fast / Quality.
 */
export const GenerationModeToggle: FC<GenerationModeToggleProps> = ({
  value,
  onChange,
  disabled,
}) => (
  <ToggleGroup
    type="single"
    variant="outline"
    size="default"
    spacing={0}
    value={value}
    onValueChange={(next) => {
      if (next === 'quality' || next === 'turbo') onChange(next);
    }}
    disabled={disabled}
    aria-label="Generation mode"
  >
    <ToggleGroupItem
      value="quality"
      aria-label="Quality mode — quality-recommended defaults"
      className="gap-1.5 px-2.5"
    >
      <Gauge className="size-3.5" />
      Quality
    </ToggleGroupItem>
    <ToggleGroupItem
      value="turbo"
      aria-label="Turbo mode — speed-recommended defaults"
      className="gap-1.5 px-2.5"
    >
      <Zap className="size-3.5" />
      Turbo
    </ToggleGroupItem>
  </ToggleGroup>
);
