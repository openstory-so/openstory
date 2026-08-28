import { useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { UpdateAllDialog } from '@/components/staleness/update-all-dialog';
import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import type { UpdateStaleDepth } from '@/lib/shots/update-stale-depth';
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

type StalenessIndicatorDensity =
  | 'inline'
  | 'corner-dot'
  | 'status-line'
  | 'header-chip';

/** The subset the divergent/sheet banners branch on; they render no others. */
export type BannerDensity = Extract<
  StalenessIndicatorDensity,
  'inline' | 'corner-dot'
>;

type StalenessIndicatorBaseProps = {
  entityType: StalenessEntityType;
  /** Workflow currently in flight — disables the regenerate trigger and shows a spinner so rapid clicks don't enqueue duplicate runs. */
  isRegenerating?: boolean;
  className?: string;
};

type StalenessIndicatorProps = StalenessIndicatorBaseProps &
  (
    | {
        density?: 'inline';
        artifact: StalenessArtifact;
        onRegenerate: () => void;
        onDismiss?: () => void;
      }
    | {
        // Non-interactive: safe to nest inside other interactive parents
        // (e.g. TabsTrigger). No regenerate handler — drive that from the
        // tab body's inline banner instead.
        density: 'corner-dot';
        artifact: StalenessArtifact;
        onRegenerate?: never;
        onDismiss?: never;
      }
    | {
        // Quiet one-line summary (#1077): amber dot + muted message + an
        // optional text action. Staleness is a routine editing state, not a
        // failure — no fill, no triangle. Omit both handlers for a purely
        // informational line. `onRegenerateDepth` renders the action as a
        // depth menu (#1085: prompts / images / video / music) and takes
        // precedence over the plain `onRegenerate` click. Covers any mix of
        // artifacts, so `artifact` is optional.
        density: 'status-line';
        artifact?: StalenessArtifact;
        onRegenerate?: () => void;
        onRegenerateDepth?: (depth: UpdateStaleDepth) => void;
        /** The shot's staleness — explains "what changed" in the depth dialog (#1194). */
        staleness?: ShotStaleness;
        /** Dry-run preview scope for the depth dialog (#1194). Required with `onRegenerateDepth`. */
        updateAllScope?: {
          sequenceId: string;
          sceneId?: string;
          shotId?: string;
        };
        /** Defaults to "Out of date since your last edit". */
        message?: string;
        /** Defaults to "Update all". */
        actionLabel?: string;
        /** `'unknown'` — the check itself failed; muted dot, not amber. */
        tone?: 'stale' | 'unknown';
        /** Trailing content on the same line, e.g. shot-number chips. */
        children?: React.ReactNode;
        onDismiss?: never;
      }
    | {
        // Inline chip for an artifact's header row (#1077):
        // `⏺ Outdated · Regenerate`.
        density: 'header-chip';
        artifact: StalenessArtifact;
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
  const { entityType, isRegenerating = false, className } = props;
  const [dismissed, setDismissed] = useState(false);
  // Status-line "Update all" opens the depth confirm dialog (#1085).
  const [updateAllOpen, setUpdateAllOpen] = useState(false);

  if (dismissed) return null;

  const artifact = 'artifact' in props ? props.artifact : undefined;
  const ariaLabel = artifact
    ? `Stale ${ARTIFACT_LABEL[artifact]} on this ${entityType} — inputs changed since it was generated`
    : `Stale artifacts on this ${entityType} — inputs changed since they were generated`;

  if (props.density === 'corner-dot') {
    // Non-interactive: corner-dot is a presentational signal that nests inside
    // tab triggers and other interactive parents. Regeneration always happens
    // from the tab body's inline banner where there's room for proper UX.
    // artifact is required on this density branch.
    const cornerArtifact = props.artifact;
    const dotLabel = isRegenerating
      ? `Regenerating ${ARTIFACT_LABEL[cornerArtifact]}…`
      : ariaLabel;
    return (
      <span
        aria-busy={isRegenerating || undefined}
        title={
          isRegenerating ? 'Regenerating…' : 'Inputs changed since generation'
        }
        data-slot="staleness-indicator-dot"
        data-artifact={cornerArtifact}
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
    const unknown = props.tone === 'unknown';
    return (
      <div
        data-slot="staleness-indicator"
        data-density="status-line"
        data-artifact={artifact}
        data-entity-type={entityType}
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground',
          className
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            unknown ? 'bg-muted-foreground/50' : 'bg-amber-500'
          )}
        />
        <span className="min-w-0 truncate">{message}</span>
        {props.children}
        {props.onRegenerateDepth ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => setUpdateAllOpen(true)}
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
            <UpdateAllDialog
              open={updateAllOpen}
              onOpenChange={setUpdateAllOpen}
              staleShots={props.staleness ? [props.staleness] : []}
              scope={props.updateAllScope ?? { sequenceId: '' }}
              onConfirm={(depth: UpdateStaleDepth) => {
                setUpdateAllOpen(false);
                props.onRegenerateDepth?.(depth);
              }}
            />
          </>
        ) : props.onRegenerate ? (
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
        ) : null}
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

  // Inline density (artifact required on this branch).
  const { onRegenerate, onDismiss, artifact: inlineArtifact } = props;
  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };
  return (
    <Alert
      data-slot="staleness-indicator"
      data-density="inline"
      data-artifact={inlineArtifact}
      data-entity-type={entityType}
      className={cn(
        'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50',
        className
      )}
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Inputs changed</AlertTitle>
      <AlertDescription>
        This {ARTIFACT_LABEL[inlineArtifact]} was generated from earlier inputs.
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
