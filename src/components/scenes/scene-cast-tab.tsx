/**
 * Cast facet (#986)
 * Selection-scoped character list: `characterTags: null` shows the whole
 * sequence's cast (nothing selected), a tag set shows the union for the
 * selected scene(s)/shot. Cards deep-link to the existing edit pages.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import type { Character } from '@/lib/db/schema';
import { matchCharactersToScene } from '@/lib/workflows/scene-matching';
import { Link } from '@tanstack/react-router';
import { Film, User } from 'lucide-react';

type SceneCastTabProps = {
  sequenceId: string;
  /** Selection-derived character tags; `null` = no filter (whole sequence). */
  characterTags: string[] | null;
};

type CastCardProps = {
  character: Character;
  sequenceId: string;
};

const CastCard: React.FC<CastCardProps> = ({ character, sequenceId }) => {
  return (
    <Link
      to="/sequences/$id/cast/$characterId"
      params={{ id: sequenceId, characterId: character.id }}
      className="group relative block overflow-hidden rounded-lg bg-card cursor-pointer"
    >
      {/* Character avatar - cropped from right side of sheet where large headshot lives */}
      <div className="aspect-square relative overflow-hidden bg-muted">
        {character.sheetImageUrl ? (
          <img
            src={character.sheetImageUrl}
            alt={character.name}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            style={{
              // The character sheet is 16:9 with a large headshot on the right side
              // Crop to the right ~25% and lower ~60% where the headshot panel is
              objectPosition: '95% 75%',
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-12 w-12 text-muted-foreground/20" />
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

        {/* Character info overlay */}
        <div className="absolute inset-x-0 bottom-0 p-4">
          <h3 className="text-sm font-medium tracking-wider text-white uppercase">
            {character.name}
          </h3>
          {(character.age || character.gender) && (
            <p className="mt-1 text-xs text-white/70">
              {[character.age, character.gender].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>

      {/* Description below card */}
      {character.physicalDescription && (
        <div className="p-3 border-t border-border/50">
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {character.physicalDescription}
          </p>
        </div>
      )}
    </Link>
  );
};

const CastCardSkeleton: React.FC = () => (
  <div className="overflow-hidden rounded-lg bg-card">
    <div className="aspect-square relative">
      <Skeleton className="h-full w-full" />
    </div>
    <div className="p-3 border-t border-border/50 space-y-2">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  </div>
);

export const SceneCastTab: React.FC<SceneCastTabProps> = ({
  sequenceId,
  characterTags,
}) => {
  const { data: characters, isLoading } = useSequenceCharacters(sequenceId);

  const scopedCast = !characters
    ? []
    : characterTags === null
      ? characters
      : matchCharactersToScene(characters, characterTags);

  // Loading state
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <CastCardSkeleton />
        <CastCardSkeleton />
      </div>
    );
  }

  // Empty state - no characters in this selection
  if (scopedCast.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <Film className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {characterTags === null
            ? 'No cast in this sequence'
            : 'No cast in this selection'}
        </p>
        {characterTags !== null && characterTags.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground/70">
            {characterTags.length} character tag
            {characterTags.length > 1 ? 's' : ''} found but no matches
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
        <span>Cast</span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          {scopedCast.length} character{scopedCast.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {scopedCast.map((character) => (
          <CastCard
            key={character.id}
            character={character}
            sequenceId={sequenceId}
          />
        ))}
      </div>
    </div>
  );
};
