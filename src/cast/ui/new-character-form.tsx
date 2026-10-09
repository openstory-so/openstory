import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import { toast } from 'sonner';
import { z } from 'zod';

const newCharacterSchema = z.object({
  name: z.string().trim().min(1).max(255),
  physicalDescription: z.string().max(2000),
  // '' from a sequence's cast panel: the sequence style's rendering (#2017).
  rendering: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => (v.length > 0 ? v : undefined)),
});

/**
 * The fields a character is made from by hand: a name plus an optional
 * appearance. One form for both places a character is made: a sequence's
 * cast panel (#1108) and the Characters page (#2065). The rest of the bible
 * is edited on the character's own page.
 */
export const NewCharacterForm: React.FC<{
  /**
   * What the character is rendered as (#2017). Required on the Characters
   * page (a default to edit); null in a sequence, where blank means the
   * sequence style's.
   */
  defaultRendering: string | null;
  isPending: boolean;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (fields: z.output<typeof newCharacterSchema>) => void;
}> = ({ defaultRendering, isPending, submitLabel, pendingLabel, onSubmit }) => (
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
    <div className="flex flex-col gap-1">
      <Label htmlFor="new-character-rendering">
        {defaultRendering === null
          ? 'Rendered as (optional, the sequence style’s if blank)'
          : 'Rendered as'}
      </Label>
      <Input
        id="new-character-rendering"
        name="rendering"
        defaultValue={defaultRendering ?? ''}
        required={defaultRendering !== null}
      />
    </div>
    <div className="flex justify-end">
      <Button type="submit" disabled={isPending}>
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </div>
  </form>
);
