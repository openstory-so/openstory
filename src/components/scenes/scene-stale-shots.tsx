import { Button } from '@/components/ui/button';
import { type ShotStaleness, shotIsStale } from '@/hooks/use-shot-staleness';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { Loader2 } from 'lucide-react';

type SceneStaleShotsProps = {
  /** The in-scope shots (a scene's, or the whole sequence's), in order. */
  shots: ShotWithImage[];
  /** Batched staleness for those shots, keyed by shot id (#1077). */
  staleness: Record<string, ShotStaleness> | undefined;
  /**
   * The staleness check failed. Without this, an errored request is
   * indistinguishable from a clean scene — both render nothing.
   */
  stalenessFailed?: boolean;
  /** Same handler the left rail uses — lands at shot scope. */
  onSelectShot: (shotId: string) => void;
  /** Regenerate every artifact that is stale right now across these shots. */
  onUpdateAll?: () => void;
  isUpdating?: boolean;
};

/**
 * Scene-scope staleness summary (#1077): one quiet line ending in clickable
 * shot-number chips that navigate down to shot scope, where the inline
 * regenerate controls live. A single line — no thumbnails — so it can't read
 * as content or compete with the reference imagery below. Renders nothing
 * while everything is fresh — no permanent strip.
 */
export const SceneStaleShots: React.FC<SceneStaleShotsProps> = ({
  shots,
  staleness,
  stalenessFailed = false,
  onSelectShot,
  onUpdateAll,
  isUpdating = false,
}) => {
  if (stalenessFailed) {
    return (
      <div
        data-testid="scene-stale-shots-error"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50"
        />
        <span>Couldn’t check whether these shots are up to date</span>
      </div>
    );
  }

  const staleShots = shots.filter((shot) => shotIsStale(staleness?.[shot.id]));
  if (staleShots.length === 0) return null;

  return (
    <div
      data-testid="scene-stale-shots"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
      />
      <span>Out of date since your edit</span>
      <span aria-hidden="true">·</span>
      {staleShots.map((shot) => {
        const number = shot.shotNumber ?? shot.orderIndex + 1;
        return (
          <Button
            key={shot.id}
            type="button"
            variant="outline"
            size="sm"
            className="h-5 rounded-full px-2 text-xs font-normal"
            onClick={() => onSelectShot(shot.id)}
            aria-label={`Open shot ${number} — out of date`}
          >
            Shot {number}
          </Button>
        );
      })}
      {onUpdateAll && (
        <>
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={onUpdateAll}
            disabled={isUpdating}
            aria-busy={isUpdating}
            aria-label="Update all out-of-date shots"
          >
            {isUpdating && (
              <Loader2
                aria-hidden="true"
                className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none"
              />
            )}
            {isUpdating ? 'Updating…' : 'Update all'}
          </Button>
        </>
      )}
    </div>
  );
};
