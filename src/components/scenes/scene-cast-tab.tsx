/**
 * Scene Cast Tab
 * Displays characters appearing in the current shot with a cinematic/editorial design
 */

import { AddCharacterDialog } from '@/components/scenes/add-character-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { facetIdsForShots, useSceneFacetMaps } from '@/hooks/use-scene-facets';
import {
  restoreSequenceCharacter,
  useSequenceCharacters,
  useSoftDeleteSequenceCharacter,
} from '@/hooks/use-sequence-characters';
import type { CharacterWithSheet } from '@/lib/db/schema';
import { errorMessage } from '@/lib/errors';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Film, Trash2, User } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AppImage } from '@/components/ui/app-image';

type SceneCastTabProps = {
  sequenceId: string;
  /** Shots in the current selection. `null` = whole sequence (show all). */
  shotIds: string[] | null;
};

type CastCardProps = {
  character: CharacterWithSheet;
  sequenceId: string;
  onDelete: (character: CharacterWithSheet) => void;
};

const CastCard: React.FC<CastCardProps> = ({
  character,
  sequenceId,
  onDelete,
}) => {
  return (
    <div className="group relative">
      <Link
        to="/sequences/$id/cast/$characterId"
        params={{ id: sequenceId, characterId: character.id }}
        className="block overflow-hidden rounded-lg bg-card cursor-pointer"
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
      {/* Sibling of the Link (never nested interactive), floated over the
          card corner. Soft delete — the confirm + undo toast live in the tab. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1 z-10 h-7 w-7 bg-black/50 text-white hover:bg-black/70 hover:text-white"
        aria-label={`Remove ${character.name} from sequence`}
        onClick={() => onDelete(character)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
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
  const queryClient = useQueryClient();
  const softDelete = useSoftDeleteSequenceCharacter();
  const [pendingDelete, setPendingDelete] = useState<CharacterWithSheet | null>(
    null
  );

  const handleConfirmDelete = (character: CharacterWithSheet) => {
    softDelete.mutate(
      { sequenceId, characterId: character.id },
      {
        onSuccess: () => {
          setPendingDelete(null);
          toast(`Removed ${character.name}`, {
            duration: 60_000,
            action: {
              label: 'Undo',
              onClick: () =>
                void restoreSequenceCharacter(queryClient, {
                  sequenceId,
                  characterId: character.id,
                }).catch((error: Error) =>
                  toast.error('Failed to restore character', {
                    description: errorMessage(error),
                  })
                ),
            },
          });
        },
        onError: (error) =>
          toast.error('Failed to remove character', {
            description: errorMessage(error),
          }),
      }
    );
  };

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

  // Add is only offered unscoped. A character belongs to the SEQUENCE, and
  // this list is filtered by which characters the selected shots reference —
  // so a newly added one (referenced by no scene yet) would not appear here,
  // and the click would read as a no-op.
  const canAdd = shotIds === null;

  if (scopedCast.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <div className="rounded-full bg-muted p-4">
          <Film className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {canAdd
            ? 'No cast yet'
            : 'No cast in this selection — clear the selection to add one'}
        </p>
        {canAdd && <AddCharacterDialog sequenceId={sequenceId} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span>{canAdd ? 'All Cast' : 'Cast'}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>
            {scopedCast.length}{' '}
            {scopedCast.length === 1 ? 'character' : 'characters'}
          </span>
        </div>
        {canAdd && <AddCharacterDialog sequenceId={sequenceId} />}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {scopedCast.map((character) => (
          <CastCard
            key={character.id}
            character={character}
            sequenceId={sequenceId}
            onDelete={setPendingDelete}
          />
        ))}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {pendingDelete?.name} from this sequence?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The character is hidden from the cast and prompt context. You can
              undo from the toast right after removing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={softDelete.isPending}
              // Radix's Action closes the dialog on click; hold it open so the
              // pending state is reachable and a second click can't double-submit.
              // `onSuccess` clears `pendingDelete`, which closes it.
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) handleConfirmDelete(pendingDelete);
              }}
            >
              {softDelete.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
