import type React from 'react';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { NewCharacterForm } from '@/cast/ui/new-character-form';
import { useNewCharacter } from '@/cast/ui/use-new-character';
import { errorMessage } from '@/platform/errors';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import { useHydrated } from '@/ui/use-hydrated';
import { useDiscardGuard } from '@/ui/use-discard-guard';

/**
 * Make a character with no sequence (#2065), then open its page, where its
 * bible and looks are edited. A sequence casts it later with @.
 */
export const NewCharacterDialog: React.FC = () => {
  const [open, setOpen] = useState(false);
  const createCharacter = useNewCharacter({
    sequenceId: null,
    rendering: () => PHOTOREAL_RENDERING,
  });
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const guard = useDiscardGuard('character');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        next ? setOpen(true) : guard.confirmDiscard(() => setOpen(false))
      }
    >
      <DialogTrigger asChild>
        <Button disabled={!hydrated}>New character</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New character</DialogTitle>
          <DialogDescription>
            The rest of the bible, looks and voice are on its page.
          </DialogDescription>
        </DialogHeader>
        <NewCharacterForm
          isPending={createCharacter.isPending}
          onEdit={guard.markDirty}
          onSubmit={(fields) =>
            createCharacter.mutate(fields, {
              onSuccess: ({ character }) => {
                guard.reset();
                setOpen(false);
                void navigate({
                  to: '/characters/$id',
                  params: { id: character.id },
                });
              },
              onError: (error) =>
                toast.error('Character not created', {
                  description: errorMessage(error),
                }),
            })
          }
        />
      </DialogContent>
      {guard.dialog}
    </Dialog>
  );
};
