import { ActionCost } from '@/components/billing/action-cost';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { UploadMediaButton } from '@/components/scenes/upload-media-button';
import { SheetComparisonDialog } from '@/components/sheets/sheet-comparison-dialog';
import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { SheetVersionStrip } from '@/components/sheets/sheet-version-strip';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useUploadCharacterSheet } from '@/hooks/use-media-upload';
import {
  characterSheetVariantKeys,
  useCharacterDivergentVariants,
  useCharacterSheetVersions,
  useDiscardCharacterSheetVariant,
  usePromoteCharacterSheetVariant,
  useSelectCharacterSheetVersion,
  useUndiscardCharacterSheetVariant,
} from '@/hooks/use-character-sheet-variants';
import {
  restoreSequenceCharacter,
  sequenceCharacterKeys,
  useAddCharacterToLibrary,
  useCharacterSheetStaleness,
  useRegenerateCharacterSheet,
  useShotIdsForCharacter,
  useRecastCharacter,
  useSequenceCharacters,
  useSoftDeleteSequenceCharacter,
} from '@/hooks/use-sequence-characters';
import type { CharacterSheetVariant, TalentWithSheets } from '@/lib/db/schema';
import { errorMessage } from '@/lib/errors';
import { useRealtime } from '@/lib/realtime/client';
import { useSheetStaleDetected } from '@/lib/realtime/use-sheet-stale-detected';
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
import { useFalPricing } from '@/hooks/use-fal-pricing';
import { useSequence } from '@/hooks/use-sequences';
import type { TextToImageModel } from '@/lib/ai/models';
import { estimateImageCost } from '@/lib/billing/cost-estimation';
import { resolveSheetImageModel } from '@/lib/sheets/sheet-image-model';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  Library,
  Loader2,
  RefreshCw,
  Trash2,
  User,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CharacterBibleForm } from './character-bible-form';
import { RecastConfirmDialog } from './recast-confirm-dialog';
import { TalentPickerDialog } from './talent-picker-dialog';
import { AppImage } from '@/components/ui/app-image';

type CharacterDetailViewProps = {
  sequenceId: string;
  characterId: string;
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
  const regenerateSheet = useRegenerateCharacterSheet();
  const { data: sequence } = useSequence(sequenceId);
  const [sheetModel, setSheetModel] = useState<TextToImageModel | null>(null);
  const { data: sheetStaleness } = useCharacterSheetStaleness(
    sequenceId,
    characterId
  );
  const { data: versionHistory } = useCharacterSheetVersions(
    sequenceId,
    characterId
  );
  const selectVersion = useSelectCharacterSheetVersion();
  const { data: shotData } = useShotIdsForCharacter(sequenceId, characterId);
  const navigate = useNavigate();
  const softDelete = useSoftDeleteSequenceCharacter();
  const uploadSheet = useUploadCharacterSheet();
  const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false);

  // Soft-remove (#1108 Phase 2): navigate back to the cast list, leave a
  // 60s undo toast. The undo closure survives this component's unmount —
  // restoreSequenceCharacter works on the app-level query client.
  const handleRemove = useCallback(
    (name: string) => {
      softDelete.mutate(
        { sequenceId, characterId },
        {
          onSuccess: () => {
            setIsRemoveConfirmOpen(false);
            void navigate({
              to: '/sequences/$id/cast',
              params: { id: sequenceId },
            });
            toast(`Removed ${name}`, {
              duration: 60_000,
              action: {
                label: 'Undo',
                onClick: () =>
                  void restoreSequenceCharacter(queryClient, {
                    sequenceId,
                    characterId,
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
    },
    [softDelete, sequenceId, characterId, navigate, queryClient]
  );

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
    regenerateSheet.isPending ||
    character?.sheetStatus === 'generating';
  const isSheetStale = sheetStaleness === 'stale';
  // A live URL can exist before the first sheet has ever completed (talent
  // preview, in-flight copy). Generate vs regenerate follows whether a sheet
  // has landed before — `sheetGeneratedAt` / selection pointer.
  const hasPriorSheet = Boolean(
    character?.sheetGeneratedAt || character?.selectedSheetVersionId
  );
  const sheetBusyLabel = hasPriorSheet
    ? 'Regenerating character sheet…'
    : 'Generating character sheet…';
  const selectedSheetModel = resolveSheetImageModel({
    explicit: sheetModel,
    liveVersionModel: (versionHistory?.versions ?? []).find(
      (row) =>
        row.id ===
        (versionHistory?.selectedSheetVersionId ??
          character?.selectedSheetVersionId)
    )?.model,
    sequenceImageModel: sequence?.imageModel ?? null,
  });
  const { pricing: falPricing } = useFalPricing();
  const sheetCostEstimate = useMemo(() => {
    if (!falPricing) return null;
    return estimateImageCost(selectedSheetModel, '16:9', 1, {
      pricing: falPricing,
      // Talent refs go through the model's edit endpoint (same as the workflow).
      edit: Boolean(character?.talentId),
    });
  }, [falPricing, selectedSheetModel, character?.talentId]);

  const handleRegenerateSheet = useCallback(() => {
    regenerateSheet.mutate(
      {
        sequenceId,
        characterId,
        ...(sheetModel ? { imageModel: sheetModel } : {}),
      },
      {
        onError: (error) =>
          toast.error('Failed to regenerate sheet', {
            description: errorMessage(error),
          }),
      }
    );
  }, [regenerateSheet, sequenceId, characterId, sheetModel]);

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
        <div className="flex flex-col gap-6 p-4">
          <SheetStalenessBanners
            entityType="character"
            divergentVariantId={characterDivergentVariant?.id}
            isStale={isSheetStale}
            onRegenerate={handleRegenerateSheet}
            onCompareDivergent={
              characterDivergentVariant
                ? () => setCompareVariant(characterDivergentVariant)
                : undefined
            }
            onPromoteDivergent={
              characterDivergentVariant
                ? () => handlePromote(characterDivergentVariant)
                : undefined
            }
            onDiscardDivergent={
              characterDivergentVariant
                ? () => handleDiscardWithUndo(characterDivergentVariant)
                : undefined
            }
          />

          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Sheet</p>
                {isSheetStale && (
                  <StalenessIndicator
                    artifact="sheet"
                    entityType="character"
                    density="header-chip"
                    isRegenerating={regenerateSheet.isPending}
                    onRegenerate={handleRegenerateSheet}
                  />
                )}
              </div>

              <div className="flex flex-col gap-2">
                <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
                  {character.sheetImageUrl ? (
                    <AppImage
                      src={character.sheetImageUrl}
                      alt={character.name}
                      width={640}
                      height={360}
                      className="h-full w-full object-cover"
                    />
                  ) : isSheetGenerating ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                      <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {sheetBusyLabel}
                      </p>
                    </div>
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
                      <User className="h-16 w-16 text-muted-foreground/20" />
                      <p className="text-sm text-muted-foreground">
                        No sheet yet
                      </p>
                    </div>
                  )}
                  {isSheetGenerating && character.sheetImageUrl ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/60">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {sheetBusyLabel}
                      </p>
                    </div>
                  ) : null}
                </div>
                <SheetVersionStrip
                  label="Versions"
                  selectingId={
                    selectVersion.isPending
                      ? selectVersion.variables.versionId
                      : null
                  }
                  onSelect={(versionId) =>
                    selectVersion.mutate(
                      { sequenceId, characterId, versionId },
                      {
                        onError: (error) =>
                          toast.error('Failed to switch sheet', {
                            description: errorMessage(error),
                          }),
                      }
                    )
                  }
                  versions={(versionHistory?.versions ?? []).map((row) => ({
                    id: row.id,
                    url: row.url,
                    selected:
                      row.id ===
                      (versionHistory?.selectedSheetVersionId ??
                        character.selectedSheetVersionId),
                  }))}
                />
              </div>

              <ImageModelSelector
                selectedModel={selectedSheetModel}
                onModelChange={setSheetModel}
                disabled={regenerateSheet.isPending || isSheetGenerating}
              />
              <p className="text-xs text-muted-foreground">
                Used for this character's sheet. Shot stills still follow the
                sequence image model.
              </p>
              <div className="flex w-fit flex-col gap-1">
                <Button
                  onClick={handleRegenerateSheet}
                  disabled={regenerateSheet.isPending}
                >
                  {regenerateSheet.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {regenerateSheet.isPending
                    ? hasPriorSheet
                      ? 'Regenerating…'
                      : 'Generating…'
                    : hasPriorSheet
                      ? isSheetGenerating
                        ? 'Generate again'
                        : 'Regenerate Sheet'
                      : 'Generate Sheet'}
                </Button>
                <ActionCost estimate={sheetCostEstimate} />
              </div>

              <div className="flex flex-wrap gap-2">
                {!character.talent && (
                  <Button
                    variant="outline"
                    onClick={() => addToLibrary.mutate(character.id)}
                    disabled={addToLibrary.isPending}
                  >
                    <Library className="mr-2 h-4 w-4" />
                    {addToLibrary.isPending ? 'Adding…' : 'Add to Library'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => setIsPickerOpen(true)}
                  disabled={isSheetGenerating}
                >
                  {character.talent ? 'Recast' : 'Cast'}
                </Button>
                <UploadMediaButton
                  label="Upload Sheet"
                  pendingLabel="Uploading…"
                  accept="image/*"
                  isPending={uploadSheet.isPending}
                  disabled={isSheetGenerating}
                  onFile={(file) =>
                    uploadSheet.mutate(
                      { file, sequenceId, characterId },
                      {
                        onSuccess: () =>
                          toast.success('Character sheet uploaded'),
                        onError: (error) =>
                          toast.error('Sheet upload failed', {
                            description: errorMessage(error),
                          }),
                      }
                    )
                  }
                />
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setIsRemoveConfirmOpen(true)}
                  disabled={softDelete.isPending}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {softDelete.isPending ? 'Removing…' : 'Remove'}
                </Button>
              </div>

              {character.talent ? (
                <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
                  <User className="h-5 w-5 text-muted-foreground" />
                  <div className="flex-1 min-h-0 min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Cast
                    </p>
                    <p className="truncate text-sm font-medium">
                      {character.talent.name}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-4">
              <CharacterBibleForm
                key={character.id}
                sequenceId={sequenceId}
                character={character}
              />
              {character.firstMentionSceneId && (
                <div className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    First Appears
                  </p>
                  <p className="text-sm">
                    {`Scene ${character.firstMentionSceneId}${
                      character.firstMentionLine
                        ? `, Line ${character.firstMentionLine}`
                        : ''
                    }`}
                  </p>
                  {character.firstMentionText && (
                    <p className="border-l-2 border-muted-foreground/30 pl-3 text-xs italic text-muted-foreground">
                      "{character.firstMentionText}"
                    </p>
                  )}
                </div>
              )}
              {character.consistencyTag && (
                <span className="w-fit rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                  {character.consistencyTag}
                </span>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>

      <AlertDialog
        open={isRemoveConfirmOpen}
        onOpenChange={setIsRemoveConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {character.name} from this sequence?
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
              onClick={() => handleRemove(character.name)}
            >
              {softDelete.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TalentPickerDialog
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        onSelect={handleTalentSelect}
      />

      {selectedTalent && (
        <RecastConfirmDialog
          open={isConfirmOpen}
          onOpenChange={setIsConfirmOpen}
          onConfirm={handleRecastConfirm}
          characterName={character.name}
          talentName={selectedTalent.name}
          replacingExisting={Boolean(character.talent)}
          affectedShotCount={shotData?.count ?? 0}
          isLoading={recastCharacter.isPending}
        />
      )}

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
