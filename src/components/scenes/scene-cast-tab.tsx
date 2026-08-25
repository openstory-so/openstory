/**
 * Scene Cast Tab
 * Displays characters appearing in the current shot with a cinematic/editorial design
 */

import { Skeleton } from '@/components/ui/skeleton';
import { facetIdsForShots, useSceneFacetMaps } from '@/hooks/use-scene-facets';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import type { Character } from '@/lib/db/schema';
import { Link } from '@tanstack/react-router';
import { Film, User } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';

type SceneCastTabProps = {
  sequenceId: string;
  /** Shots in the current selection. `null` = whole sequence (show all). */
  shotIds: string[] | null;
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
          <AppImage
            src={character.sheetImageUrl}
            alt={character.name}
            width={160}
            height={160}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
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
  shotIds,
}) => {
  const { data: characters, isLoading } = useSequenceCharacters(sequenceId);
  const { data: facetMaps } = useSceneFacetMaps(sequenceId);

  const scopedIds = facetIdsForShots(facetMaps?.characterIdsByShot, shotIds);
  const scopedCast = !characters
    ? []
    : scopedIds === null
      ? characters
      : characters.filter((c) => scopedIds.has(c.id));

  // Loading state
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <CastCardSkeleton />
        <CastCardSkeleton />
        <CastCardSkeleton />
      </div>
    );
  }

  if (scopedCast.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <Film className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {shotIds === null ? 'No cast yet' : 'No cast in this selection'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>{shotIds === null ? 'All Cast' : 'Cast'}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          {scopedCast.length}{' '}
          {scopedCast.length === 1 ? 'character' : 'characters'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
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
