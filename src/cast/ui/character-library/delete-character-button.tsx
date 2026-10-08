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
import { useDeleteTeamCharacter } from '@/cast/ui/use-team-characters';
import { errorMessage } from '@/platform/errors';
import { useHydrated } from '@/ui/use-hydrated';

/**
 * Delete one of the team's characters for good (#2065). Offered only while
 * no sequence casts it; the server refuses otherwise.
 */
export const DeleteCharacterButton: React.FC<{
  characterId: string;
  name: string;
}> = ({ characterId, name }) => {
  const remove = useDeleteTeamCharacter();
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
            Its looks, sheets and voice history go with it. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              remove.mutate(
                { characterId },
                {
                  onSuccess: () => {
                    toast.success(`Deleted ${name}`);
                    void navigate({ to: '/characters' });
                  },
                  onError: (error) =>
                    toast.error(`Could not delete ${name}`, {
                      description: errorMessage(error),
                    }),
                }
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
