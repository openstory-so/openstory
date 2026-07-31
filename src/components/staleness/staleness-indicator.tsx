import { useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type StalenessArtifact =
  | 'thumbnail'
  | 'video'
  | 'audio'
  | 'sheet'
  | 'visual-prompt'
  | 'motion-prompt'
  | 'music-prompt'
  | 'music';

export type StalenessEntityType =
  | 'shot'
  | 'character'
  | 'location'
  | 'library-location'
  | 'talent'
  | 'sequence';

export type StalenessIndicatorDensity =
  | 'inline'
  | 'corner-dot'
  | 'status-line'
  | 'header-chip';

type StalenessIndicatorBaseProps = {
  artifact: StalenessArtifact;
  entityType: StalenessEntityType;
  /** Workflow currently in flight — disables the regenerate trigger and shows a spinner so rapid clicks don't enqueue duplicate runs. */
  isRegenerating?: boolean;
  className?: string;
};

type StalenessIndicatorProps = StalenessIndicatorBaseProps &
  (
    | {
        density?: 'inline';
        onRegenerate: () => void;
        onDismiss?: () => void;
      }
    | {
        // Non-interactive: safe to nest inside other interactive parents
        // (e.g. TabsTrigger). No regenerate handler — drive that from the
        // tab body's inline banner instead.
        density: 'corner-dot';
        onRegenerate?: never;
        onDismiss?: never;
      }
    | {
        // Quiet one-line summary (#1077): amber dot + muted message + an
        // optional text action. Staleness is a routine editing state, not a
        // failure — no fill, no triangle. Omit `onRegenerate` for a purely
        // informational line; the shot-scope summary passes one to drive
        // "Update all" for that shot (#1085).
        density: 'status-line';
        onRegenerate?: () => void;
        /** Defaults to "Out of date since your last edit". */
        message?: string;
        /** Defaults to "Update all". */
        actionLabel?: string;
        onDismiss?: never;
      }
    | {
        // Inline chip for an artifact's header row (#1077):
        // `⏺ Outdated · Regenerate`.
        density: 'header-chip';
        onRegenerate: () => void;
        onDismiss?: never;
      }
  );

const ARTIFACT_LABEL: Record<StalenessArtifact, string> = {
  thumbnail: 'image',
  video: 'video',
  audio: 'audio',
  sheet: 'sheet',
  'visual-prompt': 'visual prompt',
  'motion-prompt': 'motion prompt',
  'music-prompt': 'music prompt',
  music: 'music',
};

export const StalenessIndicator: React.FC<StalenessIndicatorProps> = (
  props
) => {
  const {
    artifact,
    entityType,
    density = 'inline',
    isRegenerating = false,
    className,
  } = props;
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const ariaLabel = `Stale ${ARTIFACT_LABEL[artifact]} on this ${entityType} — inputs changed since it was generated`;

  if (density === 'corner-dot') {
    // Non-interactive: corner-dot is a presentational signal that nests inside
    // tab triggers and other interactive parents. Regeneration always happens
    // from the tab body's inline banner where there's room for proper UX.
    const dotLabel = isRegenerating
      ? `Regenerating ${ARTIFACT_LABEL[artifact]}…`
      : ariaLabel;
    return (
      <span
        aria-busy={isRegenerating || undefined}
        title={
          isRegenerating ? 'Regenerating…' : 'Inputs changed since generation'
        }
        data-slot="staleness-indicator-dot"
        data-artifact={artifact}
        data-entity-type={entityType}
        className={cn(
          'inline-flex h-4 w-4 items-center justify-center',
          className
        )}
      >
        <span className="sr-only">{dotLabel}</span>
        {isRegenerating ? (
          <Loader2
            aria-hidden="true"
            className="h-3 w-3 animate-spin text-amber-600 motion-reduce:animate-none"
          />
        ) : (
          <span
            aria-hidden="true"
            className="block h-2 w-2 rounded-full bg-amber-500 ring-2 ring-amber-500/30"
          />
        )}
      </span>
    );
  }

  if (props.density === 'status-line') {
    const message = props.message ?? 'Out of date since your last edit';
    const actionLabel = props.actionLabel ?? 'Update all';
    return (
      <div
        data-slot="staleness-indicator"
        data-density="status-line"
        data-artifact={artifact}
        data-entity-type={entityType}
        className={cn(
          'flex items-center gap-2 text-xs text-muted-foreground',
          className
        )}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
        />
        <span className="min-w-0 flex-1 truncate">{message}</span>
        {props.onRegenerate && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={props.onRegenerate}
            disabled={isRegenerating}
            aria-busy={isRegenerating}
            aria-label={`${actionLabel} — ${ariaLabel}`}
          >
            {isRegenerating && (
              <Loader2
                aria-hidden="true"
                className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none"
              />
            )}
            {isRegenerating ? 'Updating…' : actionLabel}
          </Button>
        )}
      </div>
    );
  }

  if (props.density === 'header-chip') {
    return (
      <span
        data-slot="staleness-indicator"
        data-density="header-chip"
        data-artifact={artifact}
        data-entity-type={entityType}
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground',
          className
        )}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
        />
        <span>Outdated</span>
        <span aria-hidden="true">·</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={props.onRegenerate}
          disabled={isRegenerating}
          aria-busy={isRegenerating}
          aria-label={`Regenerate — ${ariaLabel}`}
        >
          {isRegenerating && (
            <Loader2
              aria-hidden="true"
              className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none"
            />
          )}
          {isRegenerating ? 'Regenerating…' : 'Regenerate'}
        </Button>
      </span>
    );
  }

  // Inline density.
  const { onRegenerate, onDismiss } = props;
  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };
  return (
    <Alert
      data-slot="staleness-indicator"
      data-density="inline"
      data-artifact={artifact}
      data-entity-type={entityType}
      className={cn(
        'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50',
        className
      )}
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Inputs changed</AlertTitle>
      <AlertDescription>
        This {ARTIFACT_LABEL[artifact]} was generated from earlier inputs.
      </AlertDescription>
      <AlertAction className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRegenerate}
          disabled={isRegenerating}
          aria-busy={isRegenerating}
        >
          {isRegenerating && (
            <Loader2
              aria-hidden="true"
              className="mr-2 h-3 w-3 animate-spin motion-reduce:animate-none"
            />
          )}
          {isRegenerating ? 'Regenerating…' : 'Regenerate'}
        </Button>
        {onDismiss && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={handleDismiss}
            aria-label="Dismiss staleness indicator"
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
};
