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
import { useState } from 'react';

/**
 * Ask before a form with edits is thrown away: `confirmDiscard(action)` runs
 * the action at once when nothing was typed, else after Discard. Render
 * `dialog` beside the form.
 */
export function useDiscardGuard(what: string) {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);

  const confirmDiscard = (action: () => void) => {
    if (!dirty) return action();
    setPending(() => action);
  };

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => !open && setPending(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard this {what}?</AlertDialogTitle>
          <AlertDialogDescription>
            What you entered will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const action = pending;
              setPending(null);
              setDirty(false);
              action?.();
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    markDirty: () => setDirty(true),
    /** After a save: the next close needs no question. */
    reset: () => setDirty(false),
    confirmDiscard,
    dialog,
  };
}
