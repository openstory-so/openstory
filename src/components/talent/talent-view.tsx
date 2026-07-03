import { BackButton } from '@/components/layout/back-button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCharacterDivergentVariants } from '@/hooks/use-character-sheet-variants';
import {
  sequenceCharacterKeys,
  useSequenceCharacters,
} from '@/hooks/use-sequence-characters';
import { useRealtime } from '@/lib/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { TalentCard } from './talent-card';

type TalentViewProps = {
  sequenceId: string;
};

export const TalentView: React.FC<TalentViewProps> = ({ sequenceId }) => {
  const queryClient = useQueryClient();
  const {
    data: characters,
    isLoading,
    error,
  } = useSequenceCharacters(sequenceId);

  // Refresh the cast grid live as characters get created and cast during
  // generation, instead of requiring a page refresh. The character-sheet
  // workflow emits `generation.character-sheet:progress` (generating → the
  // characters now exist in the DB; completed → their sheet image is ready);
  // talent:matched / complete cover pre-cast and end-of-run. React Query
  // coalesces the resulting invalidations.
  const invalidateCharacters = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: sequenceCharacterKeys.list(sequenceId),
    });
  }, [queryClient, sequenceId]);

  useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: [
      'generation.character-sheet:progress',
      'generation.talent:matched',
      'generation.complete',
    ] as const,
    onData: invalidateCharacters,
    enabled: !!sequenceId,
  });

  const { data: divergentVariants } = useCharacterDivergentVariants(sequenceId);
  const divergentByCharacterId = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of divergentVariants ?? []) {
      // Oldest active divergence per character; the list is already
      // sorted by divergedAt ascending.
      if (!map.has(v.characterId)) map.set(v.characterId, v.id);
    }
    return map;
  }, [divergentVariants]);

  const header = (
    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
      <BackButton
        fallbackTo="/sequences/$id/scenes"
        sequenceId={sequenceId}
        label="Back to scenes"
      />
      <h1 className="text-lg font-semibold">Cast</h1>
    </div>
  );

  if (error) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-destructive">
              Failed to load characters
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {error.message}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-square w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : !characters || characters.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-muted p-6">
              <Users className="h-12 w-12 text-muted-foreground/50" />
            </div>
            <div>
              <h3 className="text-lg font-medium">No cast found</h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Characters will appear here once your script has been analyzed.
                Add a script to your sequence to get started.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {characters.map((character) => (
              <Link
                key={character.id}
                to="/sequences/$id/cast/$characterId"
                params={{ id: sequenceId, characterId: character.id }}
                className="block"
              >
                <TalentCard
                  character={character}
                  divergentVariantId={divergentByCharacterId.get(character.id)}
                />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
