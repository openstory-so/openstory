import { InButtonCost } from '@/billing/ui/action-cost';
import { ImageModelSelector } from '@/models/ui/pickers/image-model-selector';
import { UploadMediaButton } from '@/shots/ui/upload-media-button';
import { SheetComparisonDialog } from '@/cast/ui/sheets/sheet-comparison-dialog';
import { SheetStalenessBanners } from '@/cast/ui/sheets/sheet-staleness-banners';
import { SheetVersionStrip } from '@/cast/ui/sheets/sheet-version-strip';
import { wearLook } from '@/cast/character-looks';
import {
  defaultLookCaption,
  defaultLookFaceState,
  defaultLookName,
  lookSheetFaceMessage,
} from '@/cast/look-sheet-face';
import { CharacterLooksRow } from '@/cast/ui/talent/character-looks-row';
import { StalenessIndicator } from '@/shots/ui/staleness/staleness-indicator';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useUploadCharacterSheet } from '@/shots/ui/use-media-upload';
import {
  characterSheetVariantKeys,
  useCharacterDivergentVariants,
  useCharacterSheetVersions,
  useDiscardCharacterSheetVariant,
  usePromoteCharacterSheetVariant,
  useSelectCharacterSheetVersion,
  useUndiscardCharacterSheetVariant,
} from '@/cast/ui/use-character-sheet-variants';
import {
  restoreSequenceCharacter,
  sequenceCharacterKeys,
  useCharacterSheetStaleness,
  useRegenerateCharacterSheet,
  useShotIdsForCharacter,
  useRecastCharacter,
  useSaveCharacterAsTalent,
  useSequenceCharacters,
  useCopyCharacterForSequence,
  useSoftDeleteSequenceCharacter,
  useUpdateCastToCurrent,
} from '@/cast/ui/use-sequence-characters';
import { useCharacterCastElsewhere } from '@/cast/ui/use-team-characters';
import type {
  CharacterSheetVariant,
  TalentWithSheets,
} from '@/platform/server/db/schema';
import { errorMessage } from '@/platform/errors';
import { useRealtime } from '@/platform/ui/realtime/client';
import { useSheetStaleDetected } from '@/cast/ui/use-sheet-stale-detected';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import { useFalPricing } from '@/billing/ui/use-fal-pricing';
import { useSequence } from '@/sequences/ui/use-sequences';
import type { TextToImageModel } from '@/models/models';
import { estimateImageCost } from '@/billing/cost-estimation';
import { resolveSheetImageModel } from '@/cast/sheet-image-model';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Loader2, Mic, RefreshCw, Trash2, User } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { isBehindCurrentVersion } from '@/cast/version-behind';
import { CharacterBibleForm } from './character-bible-form';
import { CharacterVoiceSection } from './character-voice-section';
import { MoveSequencesDialog } from './move-sequences-dialog';
import { RecastConfirmDialog } from './recast-confirm-dialog';
import { TalentPickerDialog } from './talent-picker-dialog';
import { AppImage } from '@/ui/shadcn/app-image';

/** "A, B and 48 others": a recast across fifty sequences names three. */
const leftBehindLabel = (rows: readonly { title: string }[]): string => {
  const titles = rows.map((row) => row.title);
  if (titles.length <= 3) return titles.join(', ');
  const rest = titles.length - 2;
  return `${titles.slice(0, 2).join(', ')} and ${rest} others`;
};

type CharacterDetailViewProps = {
  sequenceId: string;
  characterId: string;
  /**
   * `sequence`: its own header, with the way back to the sequence's cast.
   * `none`: the page around it names the character (the Characters page).
   */
  header: 'sequence' | 'none';
};

export const CharacterDetailView: React.FC<CharacterDetailViewProps> = ({
  sequenceId,
  characterId,
  header,
}) => {
  const queryClient = useQueryClient();
  const {
    data: characters,
    isLoading,
    error,
  } = useSequenceCharacters(sequenceId);
  const saveAsTalent = useSaveCharacterAsTalent();
  const recastCharacter = useRecastCharacter();
  const regenerateSheet = useRegenerateCharacterSheet();
  const { data: sequence } = useSequence(sequenceId);
  const [sheetModel, setSheetModel] = useState<TextToImageModel | null>(null);
  // The look whose sheet the panel shows (#2015); null is the default look.
  const [pickedLookId, setPickedLookId] = useState<string | null>(null);
  const owner = characters?.find((c) => c.id === characterId);
  const liveLooks = (owner?.looks ?? []).filter((look) => !look.deletedAt);
  const activeLook =
    liveLooks.find((look) => look.id === pickedLookId) ??
    liveLooks.find((look) => look.isDefault);
  const activeLookId = activeLook?.id ?? characterId;
  // A look other than the default is drawn from the default look's sheet.
  const faceState = defaultLookFaceState(liveLooks);
  const faceBlocked = activeLook?.isDefault === false && faceState !== 'ready';
  const faceMessage =
    activeLook?.isDefault === false
      ? lookSheetFaceMessage(defaultLookName(liveLooks), faceState)
      : activeLook
        ? defaultLookCaption(
            activeLook.name,
            liveLooks.some((look) => !look.isDefault)
          )
        : null;
  // Everything below reads the character wearing that look: its sheet,
  // status, versions and staleness are the look's.
  const character = owner && activeLook ? wearLook(owner, activeLook) : owner;
  const { data: sheetStaleness } = useCharacterSheetStaleness(
    sequenceId,
    characterId,
    activeLook?.isDefault === false ? activeLookId : undefined
  );
  const { data: versionHistory } = useCharacterSheetVersions(
    sequenceId,
    characterId,
    activeLook?.isDefault === false ? activeLookId : undefined
  );
  const selectVersion = useSelectCharacterSheetVersion();
  const { data: shotData } = useShotIdsForCharacter(sequenceId, characterId);
  const navigate = useNavigate();
  const softDelete = useSoftDeleteSequenceCharacter();
  const uploadSheet = useUploadCharacterSheet();
  const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false);
  // Version moves (#2017): this sequence pins an older version than the
  // character's current one.
  const updateToCurrent = useUpdateCastToCurrent();
  const [isMoveOpen, setIsMoveOpen] = useState(false);
  const behind = owner ? isBehindCurrentVersion(owner) : false;
  // "Move sequences" is offered when there is somewhere to move: another
  // live sequence casts the character, or this one is behind.
  const { data: castElsewhere = false } = useCharacterCastElsewhere(
    characterId,
    sequenceId
  );
  // "Make a one-off copy": a new character for this sequence alone, free.
  // Offered while another sequence casts the character too.
  const copyForSequence = useCopyCharacterForSequence();
  const [isCopyOpen, setIsCopyOpen] = useState(false);
  const handleCopy = () =>
    copyForSequence.mutate(
      { sequenceId, characterId },
      {
        onSuccess: (copy) => {
          setIsCopyOpen(false);
          toast(`${copy.name} is now this sequence's own copy.`);
          void navigate({
            to: '/sequences/$id/cast/$characterId',
            params: { id: sequenceId, characterId: copy.id },
          });
        },
        onError: (error) =>
          toast.error('Copy not made', { description: errorMessage(error) }),
      }
    );

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
  // Whether a look is generating is its own `sheetStatus`, read off the
  // list — never a flag kept here, which would stick when the look on show
  // changes mid-run (#2015). Only the retry caption is event-only state, and
  // it is kept with the look it belongs to.
  const [retry, setRetry] = useState<{ lookId: string; label: string } | null>(
    null
  );
  const retryLabel = retry?.lookId === activeLookId ? retry.label : null;

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

        // Only handle events for this character — every look of it.
        if (payload.characterId !== characterId) return;
        // A default look's id is its character's, which is what an event
        // from before looks carries.
        const lookId =
          'lookId' in data && typeof data.lookId === 'string'
            ? data.lookId
            : characterId;
        const label =
          payload.status !== 'generating' ||
          !('phase' in data) ||
          data.phase !== 'retrying'
            ? null
            : 'promptSoftened' in data && data.promptSoftened === true
              ? 'Retrying with a rewritten prompt…'
              : 'attempt' in data &&
                  'maxAttempts' in data &&
                  typeof data.attempt === 'number' &&
                  typeof data.maxAttempts === 'number'
                ? `Retrying (${data.attempt}/${data.maxAttempts})…`
                : 'Retrying…';
        setRetry((current) =>
          label
            ? { lookId, label }
            : current?.lookId === lookId
              ? null
              : current
        );
        // The look's status and sheet come from the list.
        void queryClient.invalidateQueries({
          queryKey: sequenceCharacterKeys.list(sequenceId),
        });
        if (payload.status !== 'generating') {
          // The version strip is a separate query. A completed run appends a
          // version after the kickoff mutation has returned.
          void queryClient.invalidateQueries({
            queryKey: characterSheetVariantKeys.history(
              sequenceId,
              characterId
            ),
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
    // A row with no look is the default look's, whose id is the character's.
    return divergentVariants.find(
      (v) =>
        v.characterId === characterId &&
        (v.lookId ?? v.characterId) === activeLookId
    );
  }, [divergentVariants, characterId, activeLookId]);

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

  // Determine if currently regenerating (from realtime or mutation pending)
  const isSheetGenerating =
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
  const sheetBusyLabel =
    retryLabel ??
    (hasPriorSheet
      ? 'Regenerating character sheet…'
      : 'Generating character sheet…');
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
  const { pricing: falPricing, isPending: pricingPending } = useFalPricing();
  const sheetCostEstimate = useMemo(() => {
    if (!falPricing) return pricingPending ? undefined : null;
    return estimateImageCost(selectedSheetModel, '16:9', 1, {
      pricing: falPricing,
      // A reference image uses the model's edit endpoint. The default look
      // sends the talent sheet; every other look sends the default look's sheet.
      edit:
        activeLook?.isDefault === false
          ? faceState === 'ready'
          : Boolean(character?.talentId),
    });
  }, [
    falPricing,
    pricingPending,
    selectedSheetModel,
    character?.talentId,
    activeLook?.isDefault,
    faceState,
  ]);

  const handleRegenerateSheet = useCallback(() => {
    regenerateSheet.mutate(
      {
        sequenceId,
        characterId,
        lookId: activeLookId,
        ...(sheetModel ? { imageModel: sheetModel } : {}),
      },
      {
        onError: (error) =>
          toast.error('Failed to regenerate sheet', {
            description: errorMessage(error),
          }),
      }
    );
  }, [regenerateSheet, sequenceId, characterId, activeLookId, sheetModel]);

  const handleTalentSelect = (talent: TalentWithSheets) => {
    setSelectedTalent(talent);
    setIsConfirmOpen(true);
  };

  const handleRecastConfirm = (applyToSequenceIds: string[]) => {
    if (!selectedTalent || !character) return;

    recastCharacter.mutate(
      {
        sequenceId,
        characterId: character.id,
        talentId: selectedTalent.id,
        applyToSequenceIds,
      },
      {
        onSuccess: (result) => {
          setIsConfirmOpen(false);
          setSelectedTalent(null);
          // Other looks are drawn from the new default sheet, so the recast
          // leaves them for the next update (#2015). Say which.
          if (result.looksLeftStale.length > 0) {
            toast(
              `Update redraws ${result.looksLeftStale.map((look) => look.name).join(', ')} once the new sheet lands.`,
              { duration: 60_000 }
            );
          }
          // The sequences moved to the recast redraw from their own Update;
          // the rest keep the old version (#2017).
          const moved = result.movedSequences.filter((row) => row.moved).length;
          if (moved > 0 || result.sequencesLeftBehind.length > 0) {
            toast(
              [
                moved > 0
                  ? `${moved} other ${moved === 1 ? 'sequence' : 'sequences'} moved to the new ${character.name}; each redraws from its own Update.`
                  : null,
                result.sequencesLeftBehind.length > 0
                  ? `${leftBehindLabel(result.sequencesLeftBehind)} ${result.sequencesLeftBehind.length === 1 ? 'keeps' : 'keep'} the previous version.`
                  : null,
              ]
                .filter(Boolean)
                .join(' '),
              { duration: 60_000 }
            );
          }
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
      {header === 'sequence' && (
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
      )}

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-6 p-4">
          {behind && (
            <StalenessIndicator
              entityType="character"
              density="status-line"
              message={`${character.name} is not on the current version here. This sequence keeps the version it pinned until you update it.`}
              actionLabel="Update this sequence"
              isRegenerating={updateToCurrent.isPending}
              onRegenerate={() =>
                updateToCurrent.mutate(
                  { sequenceId, characterId },
                  {
                    onError: (error) =>
                      toast.error('Sequence not updated', {
                        description: errorMessage(error),
                      }),
                  }
                )
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-xs"
                onClick={() => setIsMoveOpen(true)}
              >
                Move other sequences…
              </Button>
            </StalenessIndicator>
          )}
          <SheetStalenessBanners
            entityType="character"
            divergentVariantId={characterDivergentVariant?.id}
            isStale={isSheetStale}
            onRegenerate={faceBlocked ? undefined : handleRegenerateSheet}
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
              {character.voiceOnly ? (
                // Heard, never seen (#1585): no sheet exists or is offered.
                <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
                  <Mic className="h-5 w-5 text-muted-foreground" />
                  <div className="flex flex-col gap-1">
                    <Badge variant="secondary">Voice only</Badge>
                    <p className="text-sm text-muted-foreground">
                      Heard but never seen. No sheet is generated.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <CharacterLooksRow
                    sequenceId={sequenceId}
                    characterId={characterId}
                    looks={liveLooks}
                    activeLookId={activeLookId}
                    onSelect={setPickedLookId}
                  />
                  {faceMessage ? (
                    <p className="text-sm text-muted-foreground">
                      {faceMessage}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">
                      {activeLook?.isDefault
                        ? 'Default look'
                        : (activeLook?.name ?? 'Sheet')}
                    </p>
                    {isSheetStale && !faceBlocked && (
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
                    Used for this character's sheet. Shot stills still follow
                    the sequence image model.
                  </p>
                  <Button
                    onClick={handleRegenerateSheet}
                    disabled={regenerateSheet.isPending || faceBlocked}
                  >
                    <InButtonCost estimate={sheetCostEstimate}>
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
                    </InButtonCost>
                  </Button>
                </>
              )}

              <div className="flex flex-wrap gap-2">
                {!character.talent && !character.voiceOnly && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      saveAsTalent.mutate(
                        { sequenceId, characterId: character.id },
                        {
                          onSuccess: () =>
                            toast.success(`Saved ${character.name} as talent`),
                        }
                      )
                    }
                    disabled={saveAsTalent.isPending}
                  >
                    {saveAsTalent.isPending ? 'Saving…' : 'Save as talent'}
                  </Button>
                )}
                {!character.voiceOnly && (
                  <Button
                    variant="outline"
                    onClick={() => setIsPickerOpen(true)}
                    disabled={isSheetGenerating}
                  >
                    {character.talent ? 'Recast' : 'Cast'}
                  </Button>
                )}
                {(behind || castElsewhere) && (
                  <Button variant="outline" onClick={() => setIsMoveOpen(true)}>
                    Move sequences
                  </Button>
                )}
                {castElsewhere && (
                  <Button variant="outline" onClick={() => setIsCopyOpen(true)}>
                    Make a one-off copy
                  </Button>
                )}
                {!character.voiceOnly && (
                  <UploadMediaButton
                    label="Upload Sheet"
                    pendingLabel="Uploading…"
                    accept="image/*"
                    isPending={uploadSheet.isPending}
                    // Upload needs no face; only Generate waits for one.
                    disabled={isSheetGenerating}
                    onFile={(file) =>
                      uploadSheet.mutate(
                        { file, sequenceId, characterId, lookId: activeLookId },
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
                )}
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

              <CharacterVoiceSection
                sequenceId={sequenceId}
                character={character}
                generateVoices={sequence?.generateVoices ?? false}
              />

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
                // Uncontrolled inputs: reseed when the pinned bible version
                // moves (Update this sequence, #2017).
                key={`${character.id}:${character.selectedBibleVersionId}`}
                sequenceId={sequenceId}
                character={owner ?? character}
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

      <MoveSequencesDialog
        open={isMoveOpen}
        onOpenChange={setIsMoveOpen}
        characterId={characterId}
        characterName={character.name}
        sequenceId={sequenceId}
      />

      <AlertDialog open={isCopyOpen} onOpenChange={setIsCopyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Make a one-off copy of {character.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This sequence gets its own copy at the version it has now. Edits
              here stop reaching other sequences, and theirs stop reaching here.
              Sheets and shots stay as they are; nothing re-renders. Not while a
              sheet is generating here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={copyForSequence.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={copyForSequence.isPending}
              onClick={handleCopy}
            >
              {copyForSequence.isPending ? 'Copying…' : 'Make a copy'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {selectedTalent && (
        <RecastConfirmDialog
          open={isConfirmOpen}
          onOpenChange={setIsConfirmOpen}
          onConfirm={handleRecastConfirm}
          characterId={character.id}
          sequenceId={sequenceId}
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
