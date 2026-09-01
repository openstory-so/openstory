import { BibleField } from '@/components/bible-field';
import { Button } from '@/components/ui/button';
import { useUpdateSequenceCharacter } from '@/hooks/use-sequence-characters';
import type { CharacterWithSheet } from '@/lib/db/schema';
import { errorMessage } from '@/lib/errors';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

const characterFormSchema = z.object({
  name: z.string().trim().min(1).max(255),
  age: z.string().max(2000),
  gender: z.string().max(2000),
  ethnicity: z.string().max(2000),
  physicalDescription: z.string().max(2000),
  standardClothing: z.string().max(2000),
  distinguishingFeatures: z.string().max(2000),
});

/**
 * Editable character bible (#1108 Phase 2). Uncontrolled inputs seeded from
 * the row (key the form by character id at the call site so switching
 * characters reseeds); one Save persists every field — an emptied input clears
 * that field server-side. Prompts/sheet staleness follows by hash derivation.
 */
export const CharacterBibleForm: React.FC<{
  sequenceId: string;
  character: CharacterWithSheet;
}> = ({ sequenceId, character }) => {
  const updateCharacter = useUpdateSequenceCharacter();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = characterFormSchema.safeParse(
      Object.fromEntries(new FormData(event.currentTarget))
    );
    if (!result.success) {
      // Native `required` covers the empty name; this is the length ceiling,
      // which would otherwise make Save look like it did nothing.
      toast.error('Check the character fields', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    updateCharacter.mutate(
      { sequenceId, characterId: character.id, ...result.data },
      {
        onSuccess: () => toast.success('Character saved'),
        onError: (error) =>
          toast.error('Failed to save character', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <BibleField
        idPrefix="character"
        label="Name"
        name="name"
        defaultValue={character.name}
        required
      />
      <div className="grid grid-cols-2 gap-4">
        <BibleField
          idPrefix="character"
          label="Age"
          name="age"
          defaultValue={character.age}
        />
        <BibleField
          idPrefix="character"
          label="Gender"
          name="gender"
          defaultValue={character.gender}
        />
      </div>
      <BibleField
        idPrefix="character"
        label="Ethnicity"
        name="ethnicity"
        defaultValue={character.ethnicity}
      />
      <BibleField
        idPrefix="character"
        label="Physical Description"
        name="physicalDescription"
        defaultValue={character.physicalDescription}
        textarea
      />
      <BibleField
        idPrefix="character"
        label="Standard Clothing"
        name="standardClothing"
        defaultValue={character.standardClothing}
        textarea
      />
      <BibleField
        idPrefix="character"
        label="Distinguishing Features"
        name="distinguishingFeatures"
        defaultValue={character.distinguishingFeatures}
        textarea
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={updateCharacter.isPending}>
          {updateCharacter.isPending && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {updateCharacter.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
};
