/**
 * Generation progress as a chip, not a banner (#1427).
 *
 * The old card sat in the column flow above the scenes view, so every run
 * pushed the whole layout down and back up again. This lives in the
 * Canvas/Script toolbar's leading slot — a row that is already there and
 * already that tall — so it costs zero layout shift and covers nothing. The
 * phase detail moved into a popover, closed by default.
 */

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { formatTimeRemaining } from '@/lib/generation/time-estimate';
import { cn } from '@/lib/utils';
import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export type BannerPhase = {
  key: string;
  name: string;
  shortName: string;
  status: 'pending' | 'active' | 'completed';
  description?: string;
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

  if (isExiting && !isComplete) return null;
  // For immediate exit (exitDelayMs=0), unmount once exiting
  if (isExiting && exitDelayMs === 0) return null;

  const activePhase = phases.find((p) => p.status === 'active');
  const completedCount = phases.filter((p) => p.status === 'completed').length;
  const progressValue = activePhase ? completedCount + 1 : completedCount;
  const percent = Math.round((progressValue / phases.length) * 100);

  const showCompleted = isComplete && completedLabel;
  const label = showCompleted
    ? completedLabel
    : (activePhase?.name ?? defaultLabel);

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      {/* Progress fills the chip's own background — a determinate cue that
          costs no extra height. The <progress> carries the semantics. */}
      <progress
        value={progressValue}
        max={phases.length}
        aria-label={
          activePhase
            ? `${ariaPrefix} progress: ${activePhase.name}`
            : `${ariaPrefix} progress`
        }
        className="sr-only"
      />
      <PopoverTrigger
        className={cn(
          'relative flex h-8 min-w-0 items-center gap-1.5 overflow-hidden rounded-full border bg-background px-2.5 text-xs text-muted-foreground transition-opacity duration-500 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none',
          isExiting && 'opacity-0'
        )}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-primary/10 transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
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
        <span className="relative hidden truncate @[15rem]:inline">
          {label}
        </span>
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
        <span className="sr-only">Show {ariaPrefix.toLowerCase()} detail</span>
      </PopoverTrigger>

      {/* Right-anchored trigger, so open leftwards from its right edge. */}
      <PopoverContent align="end" className="gap-3">
        <p className="font-medium text-foreground">{label}</p>
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

        {activePhase?.description && (
          <p className="text-xs text-muted-foreground">
            {activePhase.description}
          </p>
        )}

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
