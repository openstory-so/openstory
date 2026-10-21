import type React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/shadcn/alert-dialog';
import { Button } from '@/ui/shadcn/button';
import {
  useDeleteTeamLocation,
  useRestoreTeamLocation,
} from '@/cast/ui/use-team-locations';
import { errorMessage } from '@/platform/errors';
import { useHydrated } from '@/ui/use-hydrated';

/**
 * Delete one of the team's locations (#1695), with Undo on the toast.
 * Offered only while no sequence uses it; the server refuses otherwise.
 */
export const DeleteLocationButton: React.FC<{
  locationId: string;
  name: string;
}> = ({ locationId, name }) => {
  const remove = useDeleteTeamLocation();
  const restore = useRestoreTeamLocation();
  const navigate = useNavigate();
  const hydrated = useHydrated();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={!hydrated || remove.isPending}>
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It leaves your locations and the @ picker.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Awaited, not `mutate` callbacks: the delete empties this page's
            // own read, the button unmounts, and its callbacks would not run.
            onClick={() =>
              void remove.mutateAsync({ locationId }).then(
                () => {
                  toast.success(`Deleted ${name}`, {
                    // Undo is the only way back from this page.
                    duration: 60_000,
                    action: {
                      label: 'Undo',
                      onClick: () =>
                        restore.mutate(
                          { locationId },
                          {
                            onSuccess: () =>
                              void navigate({
                                to: '/locations/$locationId',
                                params: { locationId },
                              }),
                          }
                        ),
                    },
                  });
                  void navigate({ to: '/locations' });
                },
                (error: unknown) =>
                  toast.error(`Could not delete ${name}`, {
                    description: errorMessage(error),
                  })
              )
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
