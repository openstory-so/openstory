import { AskAssistantButton } from '@/assistant/ui/ask-assistant-button';
import { TeamCharacterCard } from '@/cast/ui/character-library/team-character-card';
import { LibraryVirtualGrid } from '@/cast/ui/library-virtual-grid';
import { useTeamCharacters } from '@/cast/ui/use-team-characters';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { User } from 'lucide-react';
import type React from 'react';

/**
 * The team's characters as a grid (#2017). Every sequence's one-off
 * characters are here too, so the rows are virtualized against the page's
 * scroller.
 */
export const TeamCharacterList: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The search box: matches name or description, any case. */
  query: string;
}> = ({ scrollRef, query }) => {
  const { data: everyCharacter } = useTeamCharacters();
  const needle = query.trim().toLowerCase();
  const characters = needle
    ? everyCharacter.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.physicalDescription?.toLowerCase().includes(needle)
      )
    : everyCharacter;

  if (characters.length === 0 && needle) {
    return (
      <EmptyState
        icon={<User className="h-12 w-12" />}
        title="No characters match"
        description={`Nothing matches “${query.trim()}”.`}
      />
    );
  }

  if (characters.length === 0) {
    return (
      <EmptyState
        icon={<User className="h-12 w-12" />}
        title="No characters yet"
        description="Make one with New character, or analyse a sequence."
        action={
          <AskAssistantButton
            context={[]}
            prompt="Create a character from a photo I describe"
          />
        }
      />
    );
  }

  return (
    <LibraryVirtualGrid
      items={characters}
      scrollRef={scrollRef}
      estimateRowHeight={320}
      renderItem={(character) => <TeamCharacterCard character={character} />}
    />
  );
};
