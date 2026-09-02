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
  disabled?: boolean;
  /**
   * What the current model actually renders at, when it can't serve the tier
   * — e.g. "Nano Banana 2 Lite renders at 1K". Shown as a caption so the pill
   * never silently lies about the output.
   */
  note?: string | null;
};

export const ResolutionPills: FC<ResolutionPillsProps> = ({
  value,
  onChange,
  disabled = false,
  note,
}) => (
  <div className="flex min-w-0 flex-col gap-1">
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
      {RESOLUTION_OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="flex h-9 min-w-0 flex-1 shrink items-center justify-center gap-1.5 px-2 sm:px-3"
          aria-label={`${option.label} — ${option.hint}`}
        >
          <span className="font-mono text-xs">{option.label}</span>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            {option.hint}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
    {note ? (
      <p className="truncate text-[10px] text-muted-foreground">{note}</p>
    ) : null}
  </div>
);
