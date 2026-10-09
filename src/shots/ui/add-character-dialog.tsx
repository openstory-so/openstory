import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import { NewCharacterForm } from '@/cast/ui/new-character-form';
import { useCreateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import { errorMessage } from '@/platform/errors';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Manual character create (#1108 Phase 2) — name plus an optional look; the
 * full bible is edited on the character's detail page, and the sheet comes
 * later via recast.
 */
export const AddCharacterDialog: React.FC<{ sequenceId: string }> = ({
  sequenceId,
}) => {
  const [open, setOpen] = useState(false);
  const createCharacter = useCreateSequenceCharacter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Character
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add character</DialogTitle>
          <DialogDescription>
            Fill in the full bible and generate a sheet from the character's
            detail page.
          </DialogDescription>
        </DialogHeader>
        <NewCharacterForm
          defaultRendering={null}
          isPending={createCharacter.isPending}
          submitLabel="Add Character"
          pendingLabel="Adding…"
          onSubmit={(fields) =>
            createCharacter.mutate(
              { sequenceId, ...fields },
              {
                onSuccess: (character) => {
                  setOpen(false);
                  toast.success(`Added ${character.name}`);
                },
                onError: (error) =>
                  toast.error('Failed to add character', {
                    description: errorMessage(error),
                  }),
              }
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
};
