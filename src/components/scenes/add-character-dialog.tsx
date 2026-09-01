import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateSequenceCharacter } from '@/hooks/use-sequence-characters';
import { errorMessage } from '@/lib/errors';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const createCharacterSchema = z.object({
  name: z.string().trim().min(1).max(255),
  physicalDescription: z.string().max(2000),
});

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

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = createCharacterSchema.safeParse(
      Object.fromEntries(new FormData(event.currentTarget))
    );
    if (!result.success) {
      toast.error('Check the character fields', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    createCharacter.mutate(
      { sequenceId, ...result.data },
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
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add CharacterWithSheet
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
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-character-name">Name</Label>
            <Input id="new-character-name" name="name" required />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-character-description">
              Physical description (optional)
            </Label>
            <Textarea
              id="new-character-description"
              name="physicalDescription"
              rows={3}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={createCharacter.isPending}>
              {createCharacter.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {createCharacter.isPending ? 'Adding…' : 'Add Character'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
