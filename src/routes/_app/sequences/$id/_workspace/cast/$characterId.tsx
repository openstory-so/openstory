import { routeParams } from '@/ui/layout/breadcrumbs';
import { CharacterDetailView } from '@/cast/ui/talent/character-detail-view';
import { useSequenceCharacters } from '@/cast/ui/use-sequence-characters';
import { createFileRoute } from '@tanstack/react-router';

function CharacterCrumbLabel({
  sequenceId,
  characterId,
}: {
  sequenceId: string;
  characterId: string;
}) {
  const { data: characters } = useSequenceCharacters(sequenceId);
  const character = characters?.find((c) => c.id === characterId);
  return <>{character?.name ?? '…'}</>;
}

export const Route = createFileRoute(
  '/_app/sequences/$id/_workspace/cast/$characterId'
)({
  component: CharacterDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const { id, characterId } = routeParams<{
        id: string;
        characterId: string;
      }>(match);
      return {
        label: (
          <CharacterCrumbLabel sequenceId={id} characterId={characterId} />
        ),
      };
    },
  },
});

function CharacterDetailPage() {
  const { id: sequenceId, characterId } = Route.useParams();

  return (
    <CharacterDetailView
      key={characterId}
      sequenceId={sequenceId}
      characterId={characterId}
      header="sequence"
    />
  );
}
