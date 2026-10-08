import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import { toast } from 'sonner';
import { z } from 'zod';

const newCharacterSchema = z.object({
  name: z.string().trim().min(1).max(255),
  physicalDescription: z.string().max(2000),
});

/**
 * The fields a character is made from by hand: a name plus an optional
 * appearance. One form for both places a character is made: a sequence's
 * cast panel (#1108) and the Characters page (#2065). The rest of the bible
 * is edited on the character's own page.
 */
export const NewCharacterForm: React.FC<{
  isPending: boolean;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (fields: z.output<typeof newCharacterSchema>) => void;
}> = ({ isPending, submitLabel, pendingLabel, onSubmit }) => (
  <form
    onSubmit={(event) => {
      event.preventDefault();
      const result = newCharacterSchema.safeParse(
        Object.fromEntries(new FormData(event.currentTarget))
      );
      if (!result.success) {
        toast.error('Check the character fields', {
          description: result.error.issues[0]?.message,
        });
        return;
      }
      onSubmit(result.data);
    }}
    className="flex flex-col gap-4"
  >
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
      <Button type="submit" disabled={isPending}>
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </div>
  </form>
);
