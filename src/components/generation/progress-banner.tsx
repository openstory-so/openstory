import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { formatTimeRemaining } from '@/lib/generation/time-estimate';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
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

  const showCompleted = isComplete && completedLabel;

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <Card
        className={cn(
          'gap-0 py-0 transition-all duration-500',
          isExiting && !prefersReducedMotion && 'translate-y-[-100%] opacity-0',
          isExiting && prefersReducedMotion && 'opacity-0'
        )}
      >
        <CardContent className="flex flex-col gap-2 py-3">
          {/* Header row */}
          <div className="flex items-center gap-3">
            {showCompleted ? (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            )}
            <span className="text-sm font-medium truncate">
              {showCompleted
                ? completedLabel
                : activePhase
                  ? activePhase.name
                  : defaultLabel}
            </span>

            <Badge
              variant="secondary"
              className="ml-auto tabular-nums"
              aria-live="polite"
            >
              {showCompleted && completedBadge
                ? completedBadge
                : formatTimeRemaining(remaining)}
            </Badge>

            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                {isOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {isOpen ? 'Collapse' : 'Expand'} progress
                </span>
              </Button>
            </CollapsibleTrigger>
          </div>

          {/* Segmented progress bar: visual is N phase divs (decorative); the real <progress> below is sr-only and carries the semantics. */}
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
          <div className="flex gap-0.5" aria-hidden="true">
            {phases.map((phase) => (
              <div
                key={phase.key}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors duration-500',
                  phase.status === 'completed' && 'bg-primary',
                  phase.status === 'active' &&
                    'bg-primary/60' +
                      (!prefersReducedMotion ? ' animate-pulse' : ''),
                  phase.status === 'pending' && 'bg-border'
                )}
              />
            ))}
          </div>
        </CardContent>

        {/* Expanded content */}
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3 border-t py-3">
            {/* Phase labels aligned to segments — hidden on mobile */}
            <div className="hidden gap-4 sm:flex">
              {phases.map((phase) => (
                <span
                  key={phase.key}
                  className={cn(
                    'flex-1 text-center text-[11px] tracking-wide',
                    phase.status === 'completed' && 'text-muted-foreground',
                    phase.status === 'active' && 'font-medium text-foreground',
                    phase.status === 'pending' && 'text-muted-foreground/40'
                  )}
                >
                  {phase.shortName}
                </span>
              ))}
            </div>

            {/* Active phase description */}
            {activePhase?.description && (
              <p className="text-sm text-muted-foreground">
                {activePhase.description}
              </p>
            )}

            {/* "You can leave" message */}
            <p className="text-xs text-muted-foreground/50">
              {leaveHint ?? (
                <>
                  Click around or create something else while you&rsquo;re
                  waiting
                </>
              )}
            </p>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
