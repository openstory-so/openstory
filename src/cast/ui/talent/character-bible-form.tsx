import { personLockMessage } from '@/cast/likeness';
import type { PersonLock } from '@/cast/likeness';
import { BibleField } from '@/cast/ui/bible-field';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { Label } from '@/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { useUpdateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import { useUpdateTeamCharacter } from '@/cast/ui/use-team-characters';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import { errorMessage } from '@/platform/errors';
import { toast } from 'sonner';
import { z } from 'zod';

const characterFormSchema = z.object({
  name: z.string().trim().min(1).max(255),
  age: z.string().max(2000),
  gender: z.string().max(2000).default(''),
  ethnicity: z.string().max(2000).default(''),
  physicalDescription: z.string().max(2000).default(''),
  rendering: z.string().max(2000).default(''),
  personality: z.string().max(2000),
  movement: z.string().max(2000).default(''),
  // A checked box submits 'on'; an unchecked one is absent from FormData.
  voiceOnly: z.preprocess((v) => v === 'on', z.boolean()),
  voiceDescription: z.string().max(2000).default(''),
  isPerson: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/** The fields the form seeds from; a cast read and a team read both have them. */
type BibleFormCharacter = Pick<
  CharacterWithSheet,
  | 'id'
  | 'name'
  | 'age'
  | 'gender'
  | 'ethnicity'
  | 'physicalDescription'
  | 'rendering'
  | 'personality'
  | 'movement'
  | 'voiceOnly'
  | 'isPerson'
> & {
  /** Why it must stay a person (#2065); null leaves the select editable. */
  personLock: PersonLock | null;
};

/**
 * Editable character bible (#1108 Phase 2). Uncontrolled inputs seeded from
 * the row (key the form by character id at the call site so switching
 * characters reseeds); one Save persists every field — an emptied input clears
 * that field server-side. Prompts/sheet staleness follows by hash derivation.
 * Clothing, hair, makeup and marks that come and go are not here: they are
 * the looks' (#2065), edited in the looks row.
 *
 * `sequenceId` null is the Characters page, for a character no sequence
 * casts (#2065): the same fields without the voice, which needs a sequence.
 */
export const CharacterBibleForm: React.FC<
  | {
      sequenceId: string;
      character: BibleFormCharacter &
        Pick<CharacterWithSheet, 'voiceDescription'>;
    }
  | { sequenceId: null; character: BibleFormCharacter }
> = (props) => {
  const { character } = props;
  const updateSequenceCharacter = useUpdateSequenceCharacter();
  const updateTeamCharacter = useUpdateTeamCharacter();
  const isPending =
    updateSequenceCharacter.isPending || updateTeamCharacter.isPending;
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
    const callbacks = {
      onSuccess: () => toast.success('Character saved'),
      onError: (error: Error) =>
        toast.error('Failed to save character', {
          description: errorMessage(error),
        }),
    };
    if (props.sequenceId === null) {
      const { voiceDescription: _noVoiceField, ...bible } = result.data;
      updateTeamCharacter.mutate(
        { characterId: character.id, ...bible },
        callbacks
      );
      return;
    }
    updateSequenceCharacter.mutate(
      {
        sequenceId: props.sequenceId,
        characterId: character.id,
        ...result.data,
      },
      callbacks
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
      {!character.voiceOnly && (
        <BibleField
          idPrefix="character"
          label="Rendered as"
          name="rendering"
          defaultValue={character.rendering}
          required
        />
      )}
      <div className="flex flex-col gap-1">
        <Label
          htmlFor="character-isPerson"
          className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          Person
        </Label>
        {/* Locked (#2065): shows Person, and with no `name` it is not
            submitted, so the server keeps what it holds. */}
        <Select
          // Uncontrolled: reseed when the lock lands or lifts.
          key={character.personLock?.reason ?? 'unlocked'}
          name={character.personLock ? undefined : 'isPerson'}
          disabled={character.personLock !== null}
          defaultValue={
            character.personLock || character.isPerson ? 'true' : 'false'
          }
          items={{
            true: 'Person',
            false: 'Not a person',
          }}
        >
          <SelectTrigger
            id="character-isPerson"
            aria-describedby={
              character.personLock ? 'character-isPerson-reason' : undefined
            }
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Person</SelectItem>
            <SelectItem value="false">Not a person</SelectItem>
          </SelectContent>
        </Select>
        {character.personLock && (
          <p
            id="character-isPerson-reason"
            className="text-xs text-muted-foreground"
          >
            {personLockMessage(character.personLock)}
          </p>
        )}
      </div>
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
        label="Personality"
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
      {props.sequenceId === null ? null : (
        <BibleField
          key={`${character.id}-voice-${props.character.voiceDescription ?? ''}`}
          idPrefix="character"
          label="Voice"
          name="voiceDescription"
          defaultValue={props.character.voiceDescription}
          textarea
          placeholder="Native English. Female, mid-50s. Excellent quality. Persona: dry detective. Emotion: unhurried, precise."
          hint="Language, age, quality, persona, emotion, timbre — what can be heard, not how they look."
        />
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
};
