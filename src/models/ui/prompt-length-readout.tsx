/**
 * Character count next to a prompt. When there is something to say, it is a
 * button with the same immediate tooltip as Download (#1763): no native
 * `title` delay, and a tap focuses it so the note opens at once.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/shadcn/tooltip';
import { cn } from '@/ui/utils';

export function PromptLengthReadout({
  measured,
  limit,
  tooltip,
  className,
}: {
  measured: number;
  limit?: number;
  /** Absent: plain digits. Present: hover or tap opens this note. */
  tooltip?: string;
  className?: string;
}) {
  const digits = (
    <>
      {measured}
      {limit !== undefined && <>&nbsp;/&nbsp;{limit}</>}
    </>
  );
  const look = cn('shrink-0 text-xs tabular-nums', className);
  if (!tooltip) return <span className={look}>{digits}</span>;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              look,
              'cursor-default rounded-sm bg-transparent p-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
            )}
          >
            {digits}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-left whitespace-normal">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
