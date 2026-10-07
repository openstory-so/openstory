import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import { useShowCosts } from '@/billing/ui/use-show-costs';
import {
  addMicros,
  microsToDisplayUsd,
  ZERO_MICROS,
  type Microdollars,
} from '@/billing/money';
import {
  useCharacterVersionMovePreview,
  useMoveCharacterCasts,
} from '@/cast/ui/use-team-characters';
import { errorMessage } from '@/platform/errors';
import { cn } from '@/ui/utils';
import { useState } from 'react';
import { toast } from 'sonner';

type MoveEpisodesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string;
  characterName: string;
  /** The sequence the panel is open in; it is listed, not singled out. */
  sequenceId: string;
};

const shots = (n: number) => `${n} ${n === 1 ? 'shot' : 'shots'}`;

/**
 * "Move many" (#2017): the sequences casting the character, those behind its
 * current version ticked by choice, each with what moves, the shots that
 * re-render and an upper-bound cost. Moving is a pointer write per sequence;
 * each moved sequence then shows out of date and is updated from its own
 * banner, where the exact plan and price are. One click never starts fifty
 * runs. Native inputs for keyboard and assistive semantics.
 */
export const MoveEpisodesDialog: React.FC<MoveEpisodesDialogProps> = ({
  open,
  onOpenChange,
  characterId,
  characterName,
  sequenceId,
}) => {
  const { showCosts } = useShowCosts();
  const {
    data: rows,
    isPending,
    isError,
  } = useCharacterVersionMovePreview(characterId, open);
  const move = useMoveCharacterCasts();
  // Ticked sequences; unset until the user touches a row, when every behind
  // sequence starts ticked.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const behind = (rows ?? []).filter((row) => row.behind);
  const chosen = picked ?? new Set(behind.map((row) => row.sequenceId));
  const chosenRows = behind.filter((row) => chosen.has(row.sequenceId));
  const total = chosenRows.reduce<Microdollars | null>(
    (acc, row) =>
      acc == null || row.costMicros == null
        ? null
        : addMicros(acc, row.costMicros),
    ZERO_MICROS
  );
  const shotTotal = chosenRows.reduce((n, row) => n + row.shotCount, 0);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  const confirm = () => {
    const sequenceIds = chosenRows.map((row) => row.sequenceId);
    move.mutate(
      { characterId, sequenceIds },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          setPicked(null);
          const moved = result.filter((row) => row.moved).length;
          toast(
            `Moved ${moved} ${moved === 1 ? 'episode' : 'episodes'} to the current ${characterName}. Each shows what to update.`
          );
        },
        onError: (error) =>
          toast.error('Episodes not moved', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Move episodes to the current {characterName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Each moved episode re-renders the shots that have {characterName}{' '}
            when you update it. Costs are an upper bound; the exact price is in
            each episode’s Update.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Episodes to move</legend>
          {isError ? (
            <span className="text-xs text-destructive" role="alert">
              Could not load the episodes.
            </span>
          ) : isPending || !rows ? (
            <span className="text-xs text-muted-foreground">…</span>
          ) : rows.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No live sequence casts {characterName}.
            </span>
          ) : (
            rows.map((row) => {
              const checked = row.behind && chosen.has(row.sequenceId);
              const cost =
                showCosts && row.costMicros != null
                  ? `up to ~${microsToDisplayUsd(row.costMicros)}`
                  : null;
              return (
                <label
                  key={row.sequenceId}
                  htmlFor={`move-episode-${row.sequenceId}`}
                  className={cn(
                    'flex items-start gap-3 rounded-md border p-3 transition-colors',
                    'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
                    row.behind ? 'cursor-pointer' : 'cursor-default',
                    checked
                      ? 'border-primary/40 bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <input
                    id={`move-episode-${row.sequenceId}`}
                    type="checkbox"
                    checked={checked}
                    disabled={!row.behind || move.isPending}
                    onChange={(e) =>
                      toggle(row.sequenceId, e.currentTarget.checked)
                    }
                    aria-label={row.title}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex min-w-0 grow flex-col gap-0.5">
                    <span className="text-sm">
                      {row.sequenceId === sequenceId
                        ? `${row.title} (this one)`
                        : row.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.behind
                        ? [
                            row.moved.length > 0
                              ? `Changes ${row.moved.join(', ')}`
                              : 'Adds a look',
                            shots(row.shotCount),
                            cost,
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : 'Up to date'}
                    </span>
                  </span>
                </label>
              );
            })
          )}
        </fieldset>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={move.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={chosenRows.length === 0 || move.isPending}
            onClick={confirm}
          >
            {move.isPending
              ? 'Moving…'
              : `Move ${chosenRows.length} ${chosenRows.length === 1 ? 'episode' : 'episodes'}`}
          </AlertDialogAction>
        </AlertDialogFooter>
        {chosenRows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {showCosts && total != null
              ? `${shots(shotTotal)} re-render on update · up to ~${microsToDisplayUsd(total)}`
              : `${shots(shotTotal)} re-render on update`}
          </p>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
};
