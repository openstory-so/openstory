import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  isResolution,
  RESOLUTION_OPTIONS,
  type Resolution,
} from '@/lib/constants/resolutions';
import { type FC } from 'react';

type ResolutionPillsProps = {
  value: Resolution;
  onChange: (value: Resolution) => void;
  /**
   * The tiers the selected model(s) can actually deliver. Only these get a
   * pill — a tier a model can't reach is not a choice, and offering it as one
   * promises a size that never arrives. Fewer than two means nothing here is
   * adjustable, so the row explains itself instead (see `note`): a lone pill
   * reads as a choice and isn't one.
   */
  available: readonly Resolution[];
  disabled?: boolean;
  /** Why the choice is narrow — e.g. "Kling v3 Pro renders at a fixed size". */
  note?: string | null;
};

export const ResolutionPills: FC<ResolutionPillsProps> = ({
  value,
  onChange,
  available,
  disabled = false,
  note,
}) => {
  const options = RESOLUTION_OPTIONS.filter((option) =>
    available.includes(option.value)
  );

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {options.length > 1 && (
        <ToggleGroup
          type="single"
          value={value}
          onValueChange={(val) => {
            if (val && isResolution(val)) onChange(val);
          }}
          variant="outline"
          spacing={0}
          disabled={disabled}
          className="w-full min-w-0 flex-nowrap justify-start"
        >
          {options.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="flex h-9 min-w-0 flex-1 shrink items-center justify-center px-2 sm:px-3"
            >
              <span className="font-mono text-xs">{option.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {note ? (
        <p className="truncate text-[10px] text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
};
