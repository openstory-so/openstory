import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import {
  CONTENT_REJECTION_USER_HINT,
  CONTENT_REJECTION_USER_TITLE,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import {
  CREDITS_SHORT_TITLE,
  creditsShortHint,
} from '@/lib/billing/credits-short';
import type { FailureSummary } from '@/lib/failures/failure-analysis';
import {
  AlertCircle,
  CreditCard,
  Info,
  Loader2,
  Play,
  RotateCcw,
} from 'lucide-react';

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

  return (
    <Alert
      variant={calm ? 'default' : 'destructive'}
      className="mx-4 mt-2"
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
      <AlertDescription>
        {isCredits ? (
          <p>{creditsShortHint(summary.error)}</p>
        ) : summary.requiresFullRetry || isWarning ? (
          <p>{summary.headline}</p>
        ) : null}
        {isWarning && <p>{CONTENT_REJECTION_USER_HINT}</p>}

        {summary.groups.length === 0 && summary.error && !calm && (
          <p className="mt-1 text-xs font-mono">{errorLabel(summary.error)}</p>
        )}

        {summary.groups.length > 0 && !isCredits && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs underline">
              {isWarning ? 'Which shots' : 'View error details'}
            </summary>
            <div className="mt-2 space-y-2 text-xs font-mono">
              {summary.groups.map((group) => (
                <div key={group.category}>
                  <span className="font-semibold">{group.category}:</span>
                  {group.shots.map((f) => (
                    <div key={f.shotId} className="ml-2">
                      {[
                        `Scene ${f.sceneNumber}`,
                        f.sceneTitle !== `Scene ${f.sceneNumber}` &&
                          ` (${f.sceneTitle})`,
                        !isWarning && `: ${errorLabel(f.error)}`,
                      ]
                        .filter(Boolean)
                        .join('')}
                    </div>
                  ))}
                  {group.error && !isWarning && (
                    <div className="ml-2">{errorLabel(group.error)}</div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        {isCredits ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={openAddCreditsDialog}>
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
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={continueGeneration}
            disabled={isRetrying}
            className="mt-2"
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
        )}
      </AlertDescription>
    </Alert>
  );
};
