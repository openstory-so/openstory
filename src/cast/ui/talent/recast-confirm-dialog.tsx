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
import { useCharacterVersionMovePreview } from '@/cast/ui/use-team-characters';
import { cn } from '@/ui/utils';
import { useState } from 'react';

type RecastConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Confirm, naming the other sequences to move to the recast version. */
  onConfirm: (applyToSequenceIds: string[]) => void;
  characterId: string;
  sequenceId: string;
  characterName: string;
  talentName: string;
  /** True when this role already has talent — copy says Recast, not Cast. */
  replacingExisting: boolean;
  affectedShotCount: number;
  isLoading: boolean;
};

/**
 * The recast is a new version pinned by this sequence (#2017). The other
 * sequences casting the character are listed, unticked: a ticked one moves to
 * the new version too and redraws from its own Update; an unticked one keeps
 * the old face and voice and shows "Newer version".
 */
export const RecastConfirmDialog: React.FC<RecastConfirmDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  characterId,
  sequenceId,
  characterName,
  talentName,
  replacingExisting,
  affectedShotCount,
  isLoading,
}) => {
  const verb = replacingExisting ? 'Recast' : 'Cast';
  const { data: casts } = useCharacterVersionMovePreview(characterId, open);
  const others = (casts ?? []).filter((row) => row.sequenceId !== sequenceId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  // The dialog stays mounted while a talent is selected: a cancel forgets
  // the ticks, so reopening does not carry a previous pick.
  const handleOpenChange = (next: boolean) => {
    if (!next) setPicked(new Set());
    onOpenChange(next);
  };
  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {talentName} as {characterName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will generate a new character sheet using {talentName} as the
            reference.
            {affectedShotCount > 0 && (
              <>
                {' '}
                <strong>
                  {affectedShotCount}{' '}
                  {affectedShotCount === 1 ? 'shot' : 'shots'}
                </strong>{' '}
                containing this character will need to be regenerated.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {others.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm">
              Also apply to these sequences. Each then redraws from its own
              Update. Unticked sequences keep the previous version.
            </legend>
            {others.map((row) => {
              const checked = picked.has(row.sequenceId);
              return (
                <label
                  key={row.sequenceId}
                  htmlFor={`recast-apply-${row.sequenceId}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border p-2 transition-colors',
                    'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
                    checked
                      ? 'border-primary/40 bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <input
                    id={`recast-apply-${row.sequenceId}`}
                    type="checkbox"
                    checked={checked}
                    disabled={isLoading}
                    onChange={(e) =>
                      toggle(row.sequenceId, e.currentTarget.checked)
                    }
                    className="accent-primary"
                  />
                  <span className="text-sm">{row.title}</span>
                </label>
              );
            })}
          </fieldset>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm([...picked])}
            disabled={isLoading}
          >
            {isLoading ? `${verb}ing…` : verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
