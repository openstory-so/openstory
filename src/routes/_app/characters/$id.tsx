import { DeleteCharacterButton } from '@/cast/ui/character-library/delete-character-button';
import { UncastCharacterEditor } from '@/cast/ui/character-library/uncast-character-editor';
import { CharacterDetailView } from '@/cast/ui/talent/character-detail-view';
import {
  useTeamCharacter,
  useTeamCharacterName,
  useTeamCharacterShotCounts,
} from '@/cast/ui/use-team-characters';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { routeParams } from '@/ui/layout/breadcrumbs';
import { Button } from '@/ui/shadcn/button';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, User } from 'lucide-react';
import { Suspense } from 'react';
import { z } from 'zod';

function CharacterCrumbLabel({ id }: { id: string }) {
  const { data: name } = useTeamCharacterName(id);
  return <>{name ?? '…'}</>;
}

export const Route = createFileRoute('/_app/characters/$id')({
  // The sequence whose casting of the character the page shows.
  validateSearch: z.object({ sequence: z.string().min(1).optional() }),
  component: TeamCharacterPage,
  staticData: {
    breadcrumb: (match) => {
      const { id } = routeParams<{ id: string }>(match);
      return [
        { label: 'Characters', to: '/characters' },
        { label: <CharacterCrumbLabel id={id} /> },
      ];
    },
  },
});

const shotsLabel = (count: number) =>
  `${count} ${count === 1 ? 'shot' : 'shots'}`;

/** Shots the character is in: one sequence, or all of them. */
function ShotCount({
  characterId,
  sequenceId,
}: {
  characterId: string;
  sequenceId: string | null;
}) {
  const { data: counts } = useTeamCharacterShotCounts(characterId);
  if (sequenceId === null) {
    return <>{shotsLabel(Object.values(counts).reduce((a, b) => a + b, 0))}</>;
  }
  const count = counts[sequenceId];
  // A sequence that started casting the character after the counts loaded.
  return <>{count === undefined ? '…' : shotsLabel(count)}</>;
}

function TeamCharacterContent({ id }: { id: string }) {
  const { sequence: pickedSequenceId } = Route.useSearch();
  const { data: character } = useTeamCharacter(id);
  // Gone or another team's. Reached from a stale link.
  if (!character) {
    return (
      <EmptyState
        icon={<User className="h-12 w-12" />}
        title="Character not found"
        description="It was deleted, or it belongs to another team."
        action={
          <Button variant="outline" asChild>
            <Link to="/characters">Back to Characters</Link>
          </Button>
        }
      />
    );
  }
  const { sequences } = character;
  // The latest sequence casting it, unless the URL names one.
  const shown = pickedSequenceId
    ? sequences.find((sequence) => sequence.id === pickedSequenceId)
    : sequences[0];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/characters" aria-label="Back to Characters">
              <ArrowLeft />
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">{character.name}</h1>
          {!character.castAnywhere && (
            <DeleteCharacterButton
              characterId={character.id}
              name={character.name}
            />
          )}
        </div>
        {sequences.length > 0 && (
          <nav
            aria-label="Sequences that cast this character"
            className="flex flex-col gap-2"
          >
            <p className="text-sm text-muted-foreground">
              Cast in {sequences.length}{' '}
              {sequences.length === 1 ? 'sequence' : 'sequences'},{' '}
              <Suspense fallback="…">
                <ShotCount characterId={id} sequenceId={null} />
              </Suspense>
              . Looks, sheets and edits below are this sequence's.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {sequences.map((sequence) => (
                <Button
                  key={sequence.id}
                  variant={sequence.id === shown?.id ? 'default' : 'outline'}
                  size="sm"
                  asChild
                >
                  <Link
                    to="/characters/$id"
                    params={{ id }}
                    search={{ sequence: sequence.id }}
                    aria-current={
                      sequence.id === shown?.id ? 'page' : undefined
                    }
                  >
                    {sequence.title} ·{' '}
                    <Suspense fallback="…">
                      <ShotCount characterId={id} sequenceId={sequence.id} />
                    </Suspense>
                  </Link>
                </Button>
              ))}
              {shown && (
                <Button variant="link" size="sm" asChild>
                  <Link
                    to="/sequences/$id/cast/$characterId"
                    params={{ id: shown.id, characterId: id }}
                  >
                    Open in {shown.title}
                  </Link>
                </Button>
              )}
            </div>
          </nav>
        )}
      </div>

      {shown ? (
        <div className="min-h-0 flex-1">
          <CharacterDetailView
            key={shown.id}
            sequenceId={shown.id}
            characterId={id}
            header="none"
          />
        </div>
      ) : sequences.length === 0 ? (
        <Suspense
          fallback={
            <div className="flex flex-col gap-4 p-4">
              <Skeleton className="h-9 w-64" />
              <Skeleton className="h-64 w-full rounded-lg" />
            </div>
          }
        >
          <UncastCharacterEditor characterId={id} />
        </Suspense>
      ) : (
        <p className="p-4 text-sm font-medium">
          Not cast in that sequence. Pick one above.
        </p>
      )}
    </div>
  );
}

function TeamCharacterPage() {
  const { id } = Route.useParams();
  const { data: session, isPending } = useAuthSession();

  if (!isPending && !session) {
    return (
      <EmptyState
        icon={<User className="h-12 w-12" />}
        title="Sign in to see this character"
        description="Characters belong to your team."
        action={<SignInButton />}
      />
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="aspect-video w-full rounded-lg" />
        </div>
      }
    >
      {!isPending && <TeamCharacterContent key={id} id={id} />}
    </Suspense>
  );
}
