import type React from 'react';
import { useState } from 'react';
import { CharacterBibleForm } from '@/cast/ui/talent/character-bible-form';
import { CharacterLooksRow } from '@/cast/ui/talent/character-looks-row';
import { useCurrentTeamCharacter } from '@/cast/ui/use-team-characters';
import { ScrollArea } from '@/ui/shadcn/scroll-area';

/**
 * A character no sequence casts (#2065): its bible and looks, edited at
 * their current versions. No pin moves, because nothing pins it. Sheets and
 * voice are a sequence's (a sheet depends on its style and image model), so
 * they are not offered here.
 */
export const UncastCharacterEditor: React.FC<{ characterId: string }> = ({
  characterId,
}) => {
  const { data: character } = useCurrentTeamCharacter(characterId);
  const [pickedLookId, setPickedLookId] = useState<string | null>(null);
  // Deleted since the page loaded.
  if (!character) {
    return <p className="p-4 text-sm font-medium">Character not found.</p>;
  }
  // No sequence, so no sheet: every look is sheet-less here.
  const looks = character.looks
    .filter((look) => !look.deletedAt)
    .map((look) => ({
      ...look,
      sheetImageUrl: null,
      sheetStatus: 'pending' as const,
    }));
  // A default look's id is its character's.
  const activeLookId =
    looks.find((look) => look.id === pickedLookId)?.id ?? characterId;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="grid items-start gap-8 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium">Not cast in a sequence.</p>
          {character.voiceOnly ? null : (
            <CharacterLooksRow
              sequenceId={null}
              characterId={characterId}
              looks={looks}
              activeLookId={activeLookId}
              onSelect={setPickedLookId}
            />
          )}
          <p className="text-sm text-muted-foreground">
            Sheets and voice need a sequence.
          </p>
        </div>
        <CharacterBibleForm
          // Uncontrolled inputs: reseed when the bible version or the default
          // look's clothing moves.
          key={`${character.bibleVersionId}:${character.standardClothing ?? ''}`}
          sequenceId={null}
          character={character}
        />
      </div>
    </ScrollArea>
  );
};
