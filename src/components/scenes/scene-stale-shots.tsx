import { UpdateAllDialog } from '@/components/staleness/update-all-dialog';
import { Button } from '@/components/ui/button';
import {
  type ShotStaleness,
  shotIsStale,
  shotIsUpdating,
} from '@/hooks/use-shot-staleness';
import type { ShotView } from '@/lib/shots/shot-view';
import type { UpdateStaleDepth } from '@/lib/shots/update-stale-depth';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

type SceneStaleShotsProps = {
  /** The in-scope shots (a scene's, or the whole sequence's), in order. */
  shots: ShotView[];
  /** Dry-run preview scope for the depth dialog (#1194). */
  sequenceId: string;
  sceneId?: string;
  /** Batched staleness for those shots, keyed by shot id (#1077). */
  staleness: Record<string, ShotStaleness> | undefined;
  /**
   * The staleness check failed. Without this, an errored request is
   * indistinguishable from a clean scene — both render nothing.
   */
  stalenessFailed?: boolean;
  /** Same handler the left rail uses — lands at shot scope. */
  onSelectShot: (shotId: string) => void;
  /**
   * Regenerate out-of-date artifacts across these shots at the chosen
   * cascade depth (#1085) — rendered as a depth menu on the action.
   */
  onUpdateAll?: (depth: UpdateStaleDepth) => void;
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
  sequenceId,
  sceneId,
  staleness,
  stalenessFailed = false,
  onSelectShot,
  onUpdateAll,
  isUpdating = false,
}) => {
  // "Update all" opens the depth confirm dialog (#1085).
  const [updateAllOpen, setUpdateAllOpen] = useState(false);
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
  // Shots whose stale artifacts are all already covered by a live server-side
  // claim (#1085) — a run (this tab's or someone else's) is fixing them now.
  const updatingShots = shots.filter(
    (shot) =>
      !shotIsStale(staleness?.[shot.id]) && shotIsUpdating(staleness?.[shot.id])
  );
  if (staleShots.length === 0 && updatingShots.length === 0) return null;

  const busy = isUpdating;

  // Chip labels use the shot's position within the IN-SCOPE list, not
  // `shotNumber`: shot numbers are per-scene, so at sequence scope every
  // scene's first shot would read "Shot 1" (#1095 review). Positions match
  // the rail's ordering because `shots` is documented as in-scope-in-order.
  const numberByShotId = new Map(shots.map((s, index) => [s.id, index + 1]));

  return (
    <div
      data-testid="scene-stale-shots"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {staleShots.length > 0 ? (
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
        />
      ) : (
        <Loader2
          aria-hidden="true"
          className="h-3 w-3 shrink-0 animate-spin text-amber-600 motion-reduce:animate-none"
        />
      )}
      <span>
        {staleShots.length > 0
          ? 'Out of date since your edit'
          : 'Updating out-of-date shots…'}
      </span>
      <span aria-hidden="true">·</span>
      {[...staleShots, ...updatingShots].map((shot) => {
        const number = numberByShotId.get(shot.id) ?? shot.shotNumber ?? 0;
        const updating = updatingShots.includes(shot);
        return (
          <Button
            key={shot.id}
            type="button"
            variant="outline"
            size="sm"
            className="h-5 rounded-full px-2 text-xs font-normal"
            onClick={() => onSelectShot(shot.id)}
            aria-label={
              updating
                ? `Open shot ${number} — updating`
                : `Open shot ${number} — out of date`
            }
          >
            {updating && (
              <Loader2
                aria-hidden="true"
                className="mr-1 h-2.5 w-2.5 animate-spin motion-reduce:animate-none"
              />
            )}
            <span>Shot {number}</span>
          </Button>
        );
      })}
      {onUpdateAll && staleShots.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setUpdateAllOpen(true)}
            disabled={busy}
            aria-busy={busy}
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
          <UpdateAllDialog
            open={updateAllOpen}
            onOpenChange={setUpdateAllOpen}
            staleShots={staleShots.flatMap((s) => staleness?.[s.id] ?? [])}
            scope={{ sequenceId, sceneId }}
            shotNumberById={numberByShotId}
            onConfirm={(depth: UpdateStaleDepth) => {
              setUpdateAllOpen(false);
              onUpdateAll(depth);
            }}
          />
        </>
      )}
    </div>
  );
};
