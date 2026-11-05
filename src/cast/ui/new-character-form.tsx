import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import { toast } from 'sonner';
import { z } from 'zod';

const newCharacterSchema = z.object({
  name: z.string().trim().min(1).max(255),
  physicalDescription: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || undefined),
  // An empty file input submits a nameless zero-byte File.
  image: z.instanceof(File).transform((f) => (f.size > 0 ? f : undefined)),
});

export type NewCharacterFields = z.output<typeof newCharacterSchema>;

/**
 * A new character (#2254): a name, and optionally a description and a photo
 * or sheet. One form for the cast panel, the Cast picker and the Characters
 * page; `useNewCharacter` makes it.
 */
export const NewCharacterForm: React.FC<{
  isPending: boolean;
  onSubmit: (fields: NewCharacterFields) => void;
}> = ({ isPending, onSubmit }) => (
  <form
    onSubmit={(event) => {
      event.preventDefault();
      // The Cast picker sits inside the new-sequence form.
      event.stopPropagation();
      const result = newCharacterSchema.safeParse(
        Object.fromEntries(new FormData(event.currentTarget))
      );
      if (!result.success) {
        toast.error('Check the character', {
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
      <Input id="new-character-name" name="name" autoComplete="off" required />
    </div>
    <div className="flex flex-col gap-1">
      <Label htmlFor="new-character-description">Description</Label>
      <Textarea
        id="new-character-description"
        name="physicalDescription"
        rows={3}
        maxLength={2000}
        placeholder="Age, build, face, hair"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
    </div>
    <div className="flex flex-col gap-1">
      <Label htmlFor="new-character-image">Photo or sheet</Label>
      <Input
        id="new-character-image"
        name="image"
        type="file"
        accept="image/*"
      />
    </div>
    <div className="flex justify-end">
      <Button type="submit" disabled={isPending}>
        {isPending ? 'Creating…' : 'Create'}
      </Button>
    </div>
  </form>
);
