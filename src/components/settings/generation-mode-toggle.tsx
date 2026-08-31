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
 * Quality | Turbo switch. Lives next to Generate: it's a generate-time
 * choice (like a model picker next to send), and the cost line under the
 * button updates with it. The generation-settings popover then shows only
 * the models that mode allows.
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
      aria-label="Quality mode — full model catalog"
      className="gap-1.5 px-2.5"
    >
      <Gauge className="size-3.5" />
      Quality
    </ToggleGroupItem>
    <ToggleGroupItem
      value="turbo"
      aria-label="Turbo mode — fastest models only"
      className="gap-1.5 px-2.5"
    >
      <Zap className="size-3.5" />
      Turbo
    </ToggleGroupItem>
  </ToggleGroup>
);
