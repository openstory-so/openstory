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
  useDeleteTeamCharacter,
  useRestoreTeamCharacter,
} from '@/cast/ui/use-team-characters';
import { errorMessage } from '@/platform/errors';
import { useHydrated } from '@/ui/use-hydrated';

/**
 * Delete one of the team's characters (#2065), with Undo on the toast.
 * Offered only while no sequence casts it; the server refuses otherwise.
 */
export const DeleteCharacterButton: React.FC<{
  characterId: string;
  name: string;
}> = ({ characterId, name }) => {
  const remove = useDeleteTeamCharacter();
  const restore = useRestoreTeamCharacter();
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
            It leaves your characters and the @ picker. A saved voice is
            released.
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
                    toast.success(`Deleted ${name}`, {
                      action: {
                        label: 'Undo',
                        onClick: () =>
                          restore.mutate(
                            { characterId },
                            {
                              onSuccess: () =>
                                void navigate({
                                  to: '/characters/$id',
                                  params: { id: characterId },
                                }),
                            }
                          ),
                      },
                    });
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
