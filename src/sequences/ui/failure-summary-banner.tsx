import { openAssistant } from '@/assistant/ui/assistant-store';
import { Alert, AlertDescription, AlertTitle } from '@/ui/shadcn/alert';
import { Button } from '@/ui/shadcn/button';
import { openAddCreditsDialog } from '@/billing/ui/use-add-credits-dialog';
import {
  CONTENT_REJECTION_USER_HINT,
  CONTENT_REJECTION_USER_TITLE,
  contentRejectionHint,
  isContentRejectionError,
} from '@/models/content-rejection';
import { CREDITS_SHORT_TITLE, creditsShortHint } from '@/billing/credits-short';
import type { FailureSummary } from '@/sequences/failure-analysis';
import { cn } from '@/ui/utils';
import { Link } from '@tanstack/react-router';
import {
  AlertCircle,
  ChevronDown,
  CreditCard,
  Info,
  Loader2,
  Play,
  RotateCcw,
} from 'lucide-react';
import { useState } from 'react';

function errorLabel(error: string | null | undefined): string {
  if (error && isContentRejectionError(error))
    return CONTENT_REJECTION_USER_TITLE;
  return error?.trim() || 'Unknown error';
}

type FailureSummaryBannerProps = {
  summary: FailureSummary;
  onRetry: () => void;
  onFullRetry?: () => void;
  isRetrying: boolean;
};

export const FailureSummaryBanner: React.FC<FailureSummaryBannerProps> = ({
  summary,
  onRetry,
  onFullRetry,
  isRetrying,
}) => {
  const isWarning = summary.tone === 'warning';
  const isCredits = summary.tone === 'credits';
  const calm = isWarning || isCredits;
  const continueGeneration = () => {
    if (summary.requiresFullRetry && onFullRetry) {
      onFullRetry();
      return;
    }
    onRetry();
  };
  // On phones this sits above the canvas; a full banner can push the preview
  // off-screen. Start collapsed there. Keep details mounted and CSS-hidden
  // (`hidden md:block`) so ≥md shows them on first paint with no matchMedia.
  const [mobileExpanded, setMobileExpanded] = useState(false);

  return (
    <Alert
      variant={calm ? 'default' : 'destructive'}
      className="mx-4 mt-2 max-md:pr-12"
      role={isCredits ? 'status' : 'alert'}
    >
      {isCredits ? (
        <CreditCard className="h-4 w-4" />
      ) : isWarning ? (
        <Info className="h-4 w-4" />
      ) : (
        <AlertCircle className="h-4 w-4" />
      )}
      <AlertTitle>
        {isCredits
          ? CREDITS_SHORT_TITLE
          : isWarning
            ? 'Content checker'
            : summary.requiresFullRetry
              ? 'Generation failed'
              : summary.headline}
      </AlertTitle>
      {/* min-w-0 lets the collapsed headline truncate instead of stretching
          the grid track past the card edge. */}
      <AlertDescription className="min-w-0">
        {isCredits ? (
          <p className={cn(!mobileExpanded && 'max-md:mb-0! max-md:truncate')}>
            {creditsShortHint(summary.error)}
          </p>
        ) : summary.requiresFullRetry || isWarning ? (
          <p className={cn(!mobileExpanded && 'max-md:mb-0! max-md:truncate')}>
            {summary.headline}
          </p>
        ) : null}
        <div
          id="failure-banner-details"
          className={cn('md:block', mobileExpanded ? 'block' : 'hidden')}
        >
          {/* A listed shot carries its own remedy below (#2104). */}
          {isWarning && summary.groups.length === 0 && (
            <p>{CONTENT_REJECTION_USER_HINT}</p>
          )}

          {summary.groups.length === 0 && summary.error && !calm && (
            <p className="mt-1 text-xs font-mono">
              {errorLabel(summary.error)}
            </p>
          )}

          {summary.groups.length > 0 && !isCredits && (
            // A content flag names each shot and its remedy, so it starts open (#2166).
            <details className="mt-2" open={isWarning}>
              <summary className="cursor-pointer text-xs underline">
                {isWarning ? 'Which shots' : 'View error details'}
              </summary>
              <div className="mt-2 space-y-2 text-xs font-mono">
                {summary.groups.map((group) => (
                  <div key={group.category}>
                    <span className="font-semibold">{group.category}:</span>
                    {group.shots.map((f) => (
                      <div key={f.shotId} className="ml-2">
                        <Link
                          from="/sequences/$id/scenes"
                          search={(prev) => ({
                            ...prev,
                            scenes: undefined,
                            shot: f.shotId,
                          })}
                          className="inline-block py-1 underline"
                        >
                          {f.sceneTitle === `Scene ${f.sceneNumber}`
                            ? f.sceneTitle
                            : `Scene ${f.sceneNumber} (${f.sceneTitle})`}
                          {` · Shot ${f.shotNumber}`}
                        </Link>
                        {`: ${isWarning ? contentRejectionHint(f.error) : errorLabel(f.error)}`}
                      </div>
                    ))}
                    {group.error && (
                      <div className="ml-2">
                        {isWarning
                          ? contentRejectionHint(group.error)
                          : errorLabel(group.error)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {isCredits ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => openAddCreditsDialog('failure_banner')}
              >
                <CreditCard />
                Add credits
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={continueGeneration}
                disabled={isRetrying}
              >
                {isRetrying ? <Loader2 className="animate-spin" /> : <Play />}
                {isRetrying ? 'Continuing\u2026' : 'Continue generation'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  openAssistant({
                    context: [],
                    starters: [
                      'Why did these fail, and retry what can be retried',
                    ],
                  })
                }
              >
                Chat about this
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={continueGeneration}
                disabled={isRetrying}
              >
                <RotateCcw
                  className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`}
                />
                {isRetrying
                  ? 'Retrying\u2026'
                  : summary.requiresFullRetry
                    ? 'Regenerate Sequence'
                    : 'Retry'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  openAssistant({
                    context: [],
                    starters: [
                      'Why did these fail, and retry what can be retried',
                    ],
                  })
                }
              >
                Chat about this
              </Button>
            </div>
          )}
        </div>
      </AlertDescription>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-0 right-0 z-20 h-11 w-11 md:hidden"
        aria-expanded={mobileExpanded}
        aria-controls="failure-banner-details"
        aria-label={mobileExpanded ? 'Hide details' : 'Show details'}
        onClick={() => setMobileExpanded((expanded) => !expanded)}
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform motion-reduce:transition-none',
            mobileExpanded && 'rotate-180'
          )}
        />
      </Button>
    </Alert>
  );
};
