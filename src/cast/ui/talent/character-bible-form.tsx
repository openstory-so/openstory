import { BibleField } from '@/cast/ui/bible-field';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Label } from '@/ui/shadcn/label';
import { useUpdateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import { errorMessage } from '@/platform/errors';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

const characterFormSchema = z.object({
  name: z.string().trim().min(1).max(255),
  age: z.string().max(2000),
  gender: z.string().max(2000).default(''),
  ethnicity: z.string().max(2000).default(''),
  physicalDescription: z.string().max(2000).default(''),
  standardClothing: z.string().max(2000).default(''),
  distinguishingFeatures: z.string().max(2000).default(''),
  personality: z.string().max(2000),
  movement: z.string().max(2000).default(''),
  // A checked box submits 'on'; an unchecked one is absent from FormData.
  voiceOnly: z.preprocess((v) => v === 'on', z.boolean()),
  voiceDescription: z.string().max(2000).default(''),
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
  // A voice-only character (#1585) has no appearance: hide the empty
  // appearance fields (the schema defaults them to '') and label
  // personality as the voice.
  const showAppearance = (value: string | null) =>
    !character.voiceOnly || Boolean(value);

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
        {showAppearance(character.gender) && (
          <BibleField
            idPrefix="character"
            label="Gender"
            name="gender"
            defaultValue={character.gender}
          />
        )}
      </div>
      {showAppearance(character.ethnicity) && (
        <BibleField
          idPrefix="character"
          label="Ethnicity"
          name="ethnicity"
          defaultValue={character.ethnicity}
        />
      )}
      {showAppearance(character.physicalDescription) && (
        <BibleField
          idPrefix="character"
          label="Physical Description"
          name="physicalDescription"
          defaultValue={character.physicalDescription}
          textarea
        />
      )}
      {showAppearance(character.standardClothing) && (
        <BibleField
          idPrefix="character"
          label="Standard Clothing"
          name="standardClothing"
          defaultValue={character.standardClothing}
          textarea
        />
      )}
      {showAppearance(character.distinguishingFeatures) && (
        <BibleField
          idPrefix="character"
          label="Distinguishing Features"
          name="distinguishingFeatures"
          defaultValue={character.distinguishingFeatures}
          textarea
        />
      )}
      {/* The way back from a bible call that misfiled an on-screen character
          as a voice (#1585): untick, save, then generate the sheet. */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="character-voiceOnly"
          name="voiceOnly"
          defaultChecked={character.voiceOnly}
        />
        <Label htmlFor="character-voiceOnly">
          Voice only — heard, never seen
        </Label>
      </div>
      <BibleField
        idPrefix="character"
        label={character.voiceOnly ? 'Voice' : 'Personality'}
        name="personality"
        defaultValue={character.personality}
        textarea
      />
      {showAppearance(character.movement) && (
        <BibleField
          idPrefix="character"
          label="Body movement"
          name="movement"
          defaultValue={character.movement}
          textarea
        />
      )}
      <BibleField
        idPrefix="character"
        label="Voice"
        name="voiceDescription"
        defaultValue={character.voiceDescription}
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
