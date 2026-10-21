/**
 * Generation progress as a chip, not a banner (#1427).
 *
 * The old card sat in the column flow above the scenes view, so every run
 * pushed the whole layout down and back up again. This lives in the
 * Canvas/Script toolbar's leading slot — a row that is already there and
 * already that tall — so it costs zero layout shift and covers nothing. The
 * phase detail moved into a popover, closed by default.
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { formatTimeRemaining } from '@/sequences/time-estimate';
import { cn } from '@/ui/utils';
import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export type BannerPhase = {
  key: string;
  name: string;
  shortName: string;
  status: 'pending' | 'active' | 'completed';
  description?: string;
};

/** One top-level run in the chip. Its child runs sit under it (#2113). */
type BannerRun = {
  key: string;
  label: string;
  /** The script-to-video phases, on the pipeline run only. */
  showPhases?: boolean;
  children: { key: string; label: string }[];
};

type ProgressBannerProps = {
  phases: BannerPhase[];
  remaining: number;
  isComplete: boolean;
  defaultLabel: string;
  ariaPrefix: string;
  completedLabel?: string;
  completedBadge?: string;
  exitDelayMs?: number;
  onExitComplete?: () => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replaces the default "you can leave" line under the phases. */
  leaveHint?: React.ReactNode;
  /**
   * Top-level runs. When set, the popover lists these instead of the phase
   * row, and a run with `showPhases` nests the phase list under itself.
   */
  runs?: BannerRun[];
  /** Hide the ETA. A count of unrelated runs has no single remaining time. */
  showRemaining?: boolean;
  /**
   * Closed-chip text when it is not the active phase name. The phase list
   * stays the script-to-video phases, nested under the pipeline row.
   */
  closedLabel?: string;
};

export const ProgressBanner: React.FC<ProgressBannerProps> = ({
  phases,
  remaining,
  isComplete,
  defaultLabel,
  ariaPrefix,
  completedLabel,
  completedBadge,
  exitDelayMs = 0,
  onExitComplete,
  isOpen,
  onOpenChange,
  leaveHint,
  runs,
  showRemaining = true,
  closedLabel,
}) => {
  const [isExiting, setIsExiting] = useState(false);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Exit animation when complete
  useEffect(() => {
    if (!isComplete) return;
    const timer = setTimeout(() => {
      setIsExiting(true);
    }, exitDelayMs);
    return () => clearTimeout(timer);
  }, [isComplete, exitDelayMs]);

  // After exit animation, call onExitComplete then unmount
  useEffect(() => {
    if (!isExiting) return;
    const timer = setTimeout(() => {
      onExitComplete?.();
    }, 500); // match transition duration
    return () => clearTimeout(timer);
  }, [isExiting, onExitComplete]);

  if (isComplete && isExiting && exitDelayMs === 0) return null;

  const activePhase = phases.find((p) => p.status === 'active');
  const completedCount = phases.filter((p) => p.status === 'completed').length;
  const progressValue = activePhase ? completedCount + 1 : completedCount;
  const percent =
    phases.length === 0 ? 0 : Math.round((progressValue / phases.length) * 100);
  const indeterminate = runs !== undefined && !showRemaining;

  const showCompleted = isComplete && completedLabel;
  const label = showCompleted
    ? completedLabel
    : (closedLabel ?? activePhase?.name ?? defaultLabel);

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      {/* Progress fills the chip's own background — a determinate cue that
          costs no extra height. The <progress> carries the semantics. */}
      <progress
        value={indeterminate ? undefined : progressValue}
        max={phases.length}
        aria-label={
          closedLabel
            ? `${ariaPrefix} progress: ${closedLabel}`
            : activePhase
              ? `${ariaPrefix} progress: ${activePhase.name}`
              : `${ariaPrefix} progress`
        }
        className="sr-only"
      />
      <PopoverTrigger
        className={cn(
          'relative flex h-8 min-w-0 items-center gap-1.5 overflow-hidden rounded-full border bg-background px-2.5 text-xs text-muted-foreground transition-opacity duration-500 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none',
          !showCompleted && 'progress-shimmer',
          isComplete && isExiting && 'opacity-0'
        )}
      >
        {indeterminate ? null : (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-primary/10 transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        )}
        {showCompleted ? (
          <Check className="relative h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <Loader2
            className={cn(
              'relative h-3.5 w-3.5 shrink-0 text-primary',
              !prefersReducedMotion && 'animate-spin'
            )}
          />
        )}
        {/* Container query, not a breakpoint: the toolbar cell this sits in
            narrows with the spine and inspector, not with the viewport. Below
            ~15rem the name drops and the chip is spinner + ETA (~4rem), which
            fits the tightest real cell. The name is always in the popover. */}
        {/* The phase name drops in a tight toolbar because the ETA is beside
            it. A run count has no ETA, so the count stays. */}
        <span
          className={cn(
            'relative truncate',
            showRemaining && 'hidden @[15rem]:inline'
          )}
          aria-live={showRemaining ? undefined : 'polite'}
        >
          {label}
        </span>
        {showRemaining ? (
          <span className="relative tabular-nums" aria-live="polite">
            {showCompleted && completedBadge ? (
              completedBadge
            ) : (
              <>
                {formatTimeRemaining(remaining)}
                <span className="sr-only"> remaining</span>
              </>
            )}
          </span>
        ) : null}
        <span className="sr-only">Show {ariaPrefix.toLowerCase()} detail</span>
      </PopoverTrigger>

      {/* Right-anchored trigger, so open leftwards from its right edge. */}
      <PopoverContent align="end" className="gap-3">
        <p className="font-medium text-foreground">{label}</p>
        {runs ? (
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            {runs.map((run) => (
              <li key={run.key} className="flex flex-col gap-1.5">
                <p className="truncate text-xs font-medium text-foreground">
                  {run.label}
                </p>
                {run.showPhases ? (
                  <PhaseList
                    phases={phases}
                    prefersReducedMotion={prefersReducedMotion}
                  />
                ) : null}
                {run.children.length > 0 ? (
                  <ul className="flex flex-col gap-1 pl-3">
                    {run.children.map((child) => (
                      <li
                        key={child.key}
                        className="truncate text-xs text-muted-foreground"
                      >
                        {child.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <PhaseList
            phases={phases}
            prefersReducedMotion={prefersReducedMotion}
          />
        )}

        {(showRemaining || runs?.some((run) => run.showPhases)) &&
        activePhase?.description ? (
          <p className="text-xs text-muted-foreground">
            {activePhase.description}
          </p>
        ) : null}

        <p className="text-xs text-muted-foreground/50">
          {leaveHint ?? (
            <>
              Click around or create something else while you&rsquo;re waiting
            </>
          )}
        </p>
      </PopoverContent>
    </Popover>
  );
};

function PhaseList({
  phases,
  prefersReducedMotion,
}: {
  phases: BannerPhase[];
  prefersReducedMotion: boolean;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {phases.map((phase) => (
        <li
          key={phase.key}
          className={cn(
            'flex items-center gap-2 text-xs',
            phase.status === 'completed' && 'text-muted-foreground',
            phase.status === 'active' && 'font-medium text-foreground',
            phase.status === 'pending' && 'text-muted-foreground/40'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              phase.status === 'completed' && 'bg-primary',
              phase.status === 'active' &&
                cn('bg-primary', !prefersReducedMotion && 'animate-pulse'),
              phase.status === 'pending' && 'bg-border'
            )}
          />
          <span className="truncate">{phase.shortName}</span>
        </li>
      ))}
    </ol>
  );
}
