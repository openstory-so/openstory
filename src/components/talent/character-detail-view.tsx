import { SheetComparisonDialog } from '@/components/sheets/sheet-comparison-dialog';
import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  characterSheetVariantKeys,
  useCharacterDivergentVariants,
  useDiscardCharacterSheetVariant,
  usePromoteCharacterSheetVariant,
  useUndiscardCharacterSheetVariant,
} from '@/hooks/use-character-sheet-variants';
import {
  sequenceCharacterKeys,
  useAddCharacterToLibrary,
  useShotIdsForCharacter,
  useRecastCharacter,
  useSequenceCharacters,
} from '@/hooks/use-sequence-characters';
import type { CharacterSheetVariant, TalentWithSheets } from '@/lib/db/schema';
import { useRealtime } from '@/lib/realtime/client';
import { useSheetStaleDetected } from '@/lib/realtime/use-sheet-stale-detected';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  Library,
  Loader2,
  RefreshCw,
  Sparkles,
  User,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RecastConfirmDialog } from './recast-confirm-dialog';
import { TalentPickerDialog } from './talent-picker-dialog';
import { AppImage } from '@/components/ui/app-image';

type CharacterDetailViewProps = {
  sequenceId: string;
  characterId: string;
};

type DetailRowProps = {
  label: string;
  value: string | number | undefined | null;
  className?: string;
};

const DetailRow: React.FC<DetailRowProps> = ({ label, value, className }) => {
  if (!value) return null;

  return (
    <div className={cn('space-y-1', className)}>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed">{value}</dd>
    </div>
  );
};

export const CharacterDetailView: React.FC<CharacterDetailViewProps> = ({
  sequenceId,
  characterId,
}) => {
  const queryClient = useQueryClient();
  const {
    data: characters,
    isLoading,
    error,
  } = useSequenceCharacters(sequenceId);
  const addToLibrary = useAddCharacterToLibrary();
  const recastCharacter = useRecastCharacter();
  const { data: shotData } = useShotIdsForCharacter(sequenceId, characterId);

  // Dialog states
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [selectedTalent, setSelectedTalent] = useState<TalentWithSheets | null>(
    null
  );

  // Track regenerating state from realtime events
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Handle realtime events for character sheet progress
  const handleRealtimeEvent = useCallback(
    (event: { event: string; data: unknown }) => {
      if (event.event === 'generation.character-sheet:progress') {
        const data = event.data;
        if (
          !data ||
          typeof data !== 'object' ||
          !('characterId' in data) ||
          !('status' in data) ||
          typeof data.characterId !== 'string' ||
          (data.status !== 'generating' &&
            data.status !== 'completed' &&
            data.status !== 'failed')
        ) {
          return;
        }
        const payload = {
          characterId: data.characterId,
          status: data.status,
        };

        // Only handle events for this character
        if (payload.characterId !== characterId) return;

        if (payload.status === 'generating') {
          setIsRegenerating(true);
        } else {
          setIsRegenerating(false);
          // Invalidate query to refetch updated character data
          void queryClient.invalidateQueries({
            queryKey: sequenceCharacterKeys.list(sequenceId),
          });
        }
      }
    },
    [characterId, queryClient, sequenceId]
  );

  // Subscribe to realtime events
  useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: ['generation.character-sheet:progress'] as const,
    onData: handleRealtimeEvent,
    enabled: !!sequenceId,
  });

  const { data: divergentVariants } = useCharacterDivergentVariants(sequenceId);
  const invalidateDivergentKeys = useCallback(
    () => [characterSheetVariantKeys.divergentBySequence(sequenceId)],
    [sequenceId]
  );
  useSheetStaleDetected({
    channelId: sequenceId,
    entityTypes: ['character'],
    invalidateKeys: invalidateDivergentKeys,
  });
  const promoteVariant = usePromoteCharacterSheetVariant();
  const discardVariant = useDiscardCharacterSheetVariant();
  const undiscardVariant = useUndiscardCharacterSheetVariant();
  const [compareVariant, setCompareVariant] =
    useState<CharacterSheetVariant | null>(null);

  const characterDivergentVariant = useMemo(() => {
    if (!divergentVariants) return undefined;
    return divergentVariants.find((v) => v.characterId === characterId);
  }, [divergentVariants, characterId]);

  const handleDiscardWithUndo = useCallback(
    (variant: CharacterSheetVariant) => {
      const restore = () =>
        undiscardVariant.mutate(
          { sequenceId, variantId: variant.id },
          {
            onSuccess: () => toast.success('Alternate restored'),
            onError: (error) => {
              toast.error('Failed to restore alternate', {
                description:
                  error instanceof Error ? error.message : 'Unknown error',
              });
            },
          }
        );
      discardVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast('Alternate discarded', {
              action: { label: 'Undo', onClick: restore },
            });
          },
          onError: (error) => {
            toast.error('Failed to discard alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, discardVariant, undiscardVariant]
  );

  const handlePromote = useCallback(
    (variant: CharacterSheetVariant) => {
      promoteVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast.success('Alternate promoted');
          },
          onError: (error) => {
            toast.error('Failed to promote alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, promoteVariant]
  );

  const character = characters?.find((c) => c.id === characterId);

  // Determine if currently regenerating (from realtime or mutation pending)
  const isSheetGenerating =
    isRegenerating ||
    recastCharacter.isPending ||
    character?.sheetStatus === 'generating';

  const handleTalentSelect = (talent: TalentWithSheets) => {
    setSelectedTalent(talent);
    setIsConfirmOpen(true);
  };

  const handleRecastConfirm = () => {
    if (!selectedTalent || !character) return;

    recastCharacter.mutate(
      { characterId: character.id, talentId: selectedTalent.id },
      {
        onSuccess: () => {
          setIsConfirmOpen(false);
          setSelectedTalent(null);
        },
      }
    );
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-destructive">Failed to load character</p>
          <p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b p-4">
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  if (!character) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <User className="h-16 w-16 text-muted-foreground/30" />
        <div className="text-center">
          <p className="text-sm font-medium">Character not found</p>
          <Link
            to="/sequences/$id/cast"
            params={{ id: sequenceId }}
            className="mt-2 text-sm text-primary hover:underline"
          >
            Back to cast
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header with back button */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Link
          to="/sequences/$id/cast"
          params={{ id: sequenceId }}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">{character.name}</h1>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-6 p-4">
          {characterDivergentVariant && (
            <SheetStalenessBanners
              entityType="character"
              divergentVariantId={characterDivergentVariant.id}
              onCompareDivergent={() =>
                setCompareVariant(characterDivergentVariant)
              }
              onPromoteDivergent={() =>
                handlePromote(characterDivergentVariant)
              }
              onDiscardDivergent={() =>
                handleDiscardWithUndo(characterDivergentVariant)
              }
            />
          )}

          {/* Character sheet image - 16:9 aspect ratio */}
          <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
            {character.sheetImageUrl && !isSheetGenerating ? (
              <AppImage
                src={character.sheetImageUrl}
                alt={character.name}
                width={160}
                height={160}
                className="h-full w-full object-cover"
              />
            ) : isSheetGenerating ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Regenerating character sheet…
                </p>
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <User className="h-20 w-20 text-muted-foreground/20" />
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            {!character.talent && (
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => addToLibrary.mutate(character.id)}
                disabled={addToLibrary.isPending}
              >
                <Library className="mr-2 h-4 w-4" />
                {addToLibrary.isPending ? 'Adding…' : 'Add to Library'}
              </Button>
            )}
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setIsPickerOpen(true)}
              disabled={isSheetGenerating}
            >
              {isSheetGenerating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {isSheetGenerating ? 'Regenerating…' : 'Recast'}
            </Button>
          </div>

          {/* Talent picker dialog */}
          <TalentPickerDialog
            open={isPickerOpen}
            onOpenChange={setIsPickerOpen}
            onSelect={handleTalentSelect}
          />

          {/* Recast confirmation dialog */}
          {selectedTalent && (
            <RecastConfirmDialog
              open={isConfirmOpen}
              onOpenChange={setIsConfirmOpen}
              onConfirm={handleRecastConfirm}
              characterName={character.name}
              talentName={selectedTalent.name}
              affectedShotCount={shotData?.count ?? 0}
              isLoading={recastCharacter.isPending}
            />
          )}

          {/* Casting status */}
          <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
            {character.talent ? (
              <>
                <User className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Cast
                  </p>
                  <p className="truncate text-sm font-medium">
                    {character.talent.name}
                  </p>
                </div>
              </>
            ) : (
              <>
                <Sparkles className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Character Sheet
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Auto-generated from script
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Character details */}
          <dl className="space-y-4">
            {/* Basic info */}
            <div className="grid grid-cols-2 gap-4">
              <DetailRow label="Age" value={character.age} />
              <DetailRow label="Gender" value={character.gender} />
            </div>

            <DetailRow label="Ethnicity" value={character.ethnicity} />

            <DetailRow
              label="Physical Description"
              value={character.physicalDescription}
            />

            <DetailRow
              label="Standard Clothing"
              value={character.standardClothing}
            />

            <DetailRow
              label="Distinguishing Features"
              value={character.distinguishingFeatures}
            />

            {/* First mention */}
            {character.firstMentionSceneId && (
              <div className="space-y-1 rounded-lg bg-muted/50 p-3">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  First Appears
                </dt>
                <dd className="text-sm">
                  Scene {character.firstMentionSceneId}
                  {character.firstMentionLine && (
                    <span>, Line {character.firstMentionLine}</span>
                  )}
                </dd>
                {character.firstMentionText && (
                  <dd className="mt-2 border-l-2 border-muted-foreground/30 pl-3 text-xs italic text-muted-foreground">
                    "{character.firstMentionText}"
                  </dd>
                )}
              </div>
            )}

            {/* Consistency tag */}
            {character.consistencyTag && (
              <div className="pt-2">
                <span className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                  {character.consistencyTag}
                </span>
              </div>
            )}
          </dl>
        </div>
      </ScrollArea>

      {compareVariant && (
        <SheetComparisonDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setCompareVariant(null);
          }}
          entityType="character"
          livePrimaryUrl={character.sheetImageUrl}
          variantUrl={compareVariant.url}
          variantId={compareVariant.id}
          onPromote={() => handlePromote(compareVariant)}
          onDiscard={() => handleDiscardWithUndo(compareVariant)}
          isPromoting={promoteVariant.isPending}
          isDiscarding={discardVariant.isPending}
        />
      )}
    </div>
  );
};
