/**
 * Film-length chip on the scene rail (#1593): the cut's running time — the
 * sum of every shot's `durationMs` — next to the sequence target. Click to
 * change the target (presets, or Auto = null, "as long as the script needs").
 * The target steers Enhance and the credit estimate only; it never rebalances
 * shots, so the chip is where the two numbers meet.
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { ToggleGroup, ToggleGroupItem } from '@/ui/shadcn/toggle-group';
import { useSetSequenceTargetDuration } from './use-sequences';
import { errorMessage } from '@/platform/errors';
import { toast } from 'sonner';

export const TARGET_DURATION_PRESETS = [
  { value: '15', label: '15s', seconds: 15 },
  { value: '30', label: '30s', seconds: 30 },
  { value: '60', label: '1m', seconds: 60 },
  { value: '120', label: '2m', seconds: 120 },
  { value: '180', label: '3m', seconds: 180 },
  { value: '300', label: '5m', seconds: 300 },
] as const;

/** "48s" / "1m 12s" — the chip's unit, not the raw second count. */
export function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

export const TargetDurationChip: React.FC<{
  sequenceId: string;
  /** Sum of `shots.durationMs` across the live cut. */
  totalSeconds: number;
  /** `sequences.targetDurationSeconds`; null / undefined = auto. */
  targetDurationSeconds: number | null | undefined;
}> = ({ sequenceId, totalSeconds, targetDurationSeconds }) => {
  const setTarget = useSetSequenceTargetDuration(sequenceId);
  const target = targetDurationSeconds ?? null;
  const label =
    target === null
      ? formatSeconds(totalSeconds)
      : `${formatSeconds(totalSeconds)} · target ${formatSeconds(target)}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label={`Running time ${label}. Change target length`}
          data-testid="film-length-chip"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Target length</p>
          <ToggleGroup
            type="single"
            value={target === null ? 'auto' : String(target)}
            onValueChange={(value) => {
              if (!value) return;
              const next = value === 'auto' ? null : Number(value);
              if (next === target) return;
              setTarget.mutate(next, {
                onError: (error) =>
                  toast.error('Failed to set target length', {
                    description: errorMessage(error),
                  }),
              });
            }}
            variant="outline"
            size="sm"
            spacing={0}
          >
            <ToggleGroupItem value="auto">Auto</ToggleGroupItem>
            {TARGET_DURATION_PRESETS.map((preset) => (
              <ToggleGroupItem key={preset.value} value={preset.value}>
                {preset.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            Steers Enhance and the estimate. Shots keep their lengths.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
