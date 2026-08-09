import { UploadMediaButton } from '@/components/scenes/upload-media-button';
import { SheetComparisonDialog } from '@/components/sheets/sheet-comparison-dialog';
import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useUploadLocationReference } from '@/hooks/use-media-upload';
import {
  locationSheetVariantKeys,
  useDiscardSequenceLocationSheetVariant,
  usePromoteSequenceLocationSheetVariant,
  useSequenceLocationDivergentVariants,
  useUndiscardSequenceLocationSheetVariant,
} from '@/hooks/use-location-sheet-variants';
import {
  restoreSequenceLocation,
  sequenceLocationKeys,
  type TeamLibraryLocation,
  useShotIdsForLocation,
  useRecastLocation,
  useSequenceLocations,
  useSoftDeleteSequenceLocation,
} from '@/hooks/use-sequence-locations';
import type { LocationSheetVariant } from '@/lib/db/schema';
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
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  Loader2,
  MapPin,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LocationBibleForm } from './location-bible-form';
import { LocationPickerDialog } from './location-picker-dialog';
import { LocationRecastConfirmDialog } from './location-recast-confirm-dialog';
import { AppImage } from '@/components/ui/app-image';

type LocationDetailViewProps = {
  sequenceId: string;
  locationId: string;
};

export const LocationDetailView: React.FC<LocationDetailViewProps> = ({
  sequenceId,
  locationId,
}) => {
  const queryClient = useQueryClient();
  const {
    data: locations,
    isLoading,
    error,
  } = useSequenceLocations(sequenceId);
  const recastLocation = useRecastLocation();
  const { data: shotData } = useShotIdsForLocation(sequenceId, locationId);
  const navigate = useNavigate();
  const softDelete = useSoftDeleteSequenceLocation();
  const uploadReference = useUploadLocationReference();
  const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false);

  // Soft-remove (#1108 Phase 2): navigate back to the locations list, leave a
  // 60s undo toast whose closure survives this component's unmount.
  const handleRemove = useCallback(
    (name: string) => {
      softDelete.mutate(
        { sequenceId, locationDbId: locationId },
        {
          onSuccess: () => {
            setIsRemoveConfirmOpen(false);
            void navigate({
              to: '/sequences/$id/locations',
              params: { id: sequenceId },
            });
            toast(`Removed ${name}`, {
              duration: 60_000,
              action: {
                label: 'Undo',
                onClick: () =>
                  void restoreSequenceLocation(queryClient, {
                    sequenceId,
                    locationDbId: locationId,
                  }).catch((error: Error) =>
                    toast.error('Failed to restore location', {
                      description: errorMessage(error),
                    })
                  ),
              },
            });
          },
          onError: (error) =>
            toast.error('Failed to remove location', {
              description: errorMessage(error),
            }),
        }
      );
    },
    [softDelete, sequenceId, locationId, navigate, queryClient]
  );

  // Dialog states for recasting
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [selectedLibraryLocation, setSelectedLibraryLocation] =
    useState<TeamLibraryLocation | null>(null);

  // Track regenerating state from realtime events
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Handle realtime events for location sheet progress
  const handleRealtimeEvent = useCallback(
    (event: { event: string; data: unknown }) => {
      if (event.event === 'generation.location-sheet:progress') {
        const data = event.data;
        if (
          !data ||
          typeof data !== 'object' ||
          !('locationId' in data) ||
          !('status' in data) ||
          typeof data.locationId !== 'string' ||
          (data.status !== 'generating' &&
            data.status !== 'completed' &&
            data.status !== 'failed')
        ) {
          return;
        }
        const payload = {
          locationId: data.locationId,
          status: data.status,
        };

        // Only handle events for this location
        if (payload.locationId !== locationId) return;

        if (payload.status === 'generating') {
          setIsRegenerating(true);
        } else {
          setIsRegenerating(false);
          // Invalidate query to refetch updated location data
          void queryClient.invalidateQueries({
            queryKey: sequenceLocationKeys.list(sequenceId),
          });
        }
      }
    },
    [locationId, queryClient, sequenceId]
  );

  // Subscribe to realtime events
  useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: ['generation.location-sheet:progress'] as const,
    onData: handleRealtimeEvent,
    enabled: !!sequenceId,
  });

  const { data: divergentVariants } =
    useSequenceLocationDivergentVariants(sequenceId);
  const invalidateDivergentKeys = useCallback(
    () => [locationSheetVariantKeys.divergentBySequence(sequenceId)],
    [sequenceId]
  );
  useSheetStaleDetected({
    channelId: sequenceId,
    entityTypes: ['location'],
    invalidateKeys: invalidateDivergentKeys,
  });
  const promoteVariant = usePromoteSequenceLocationSheetVariant();
  const discardVariant = useDiscardSequenceLocationSheetVariant();
  const undiscardVariant = useUndiscardSequenceLocationSheetVariant();
  const [compareVariant, setCompareVariant] =
    useState<LocationSheetVariant | null>(null);

  const locationDivergentVariant = useMemo(() => {
    if (!divergentVariants) return undefined;
    return divergentVariants.find((v) => v.parentId === locationId);
  }, [divergentVariants, locationId]);

  const handleDiscardWithUndo = useCallback(
    (variant: LocationSheetVariant) => {
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
    (variant: LocationSheetVariant) => {
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

  const location = locations?.find((l) => l.id === locationId);

  // Determine if currently regenerating
  const isSheetGenerating =
    isRegenerating ||
    recastLocation.isPending ||
    location?.referenceStatus === 'generating';

  // Handle library location selection from picker
  const handleLibraryLocationSelect = (
    libraryLocation: TeamLibraryLocation
  ) => {
    setSelectedLibraryLocation(libraryLocation);
    setIsConfirmOpen(true);
  };

  // Handle recast confirmation
  const handleRecastConfirm = () => {
    if (!selectedLibraryLocation || !location?.referenceImageUrl) return;

    recastLocation.mutate(
      {
        locationId: location.id,
        libraryLocationId: selectedLibraryLocation.id,
        referenceImageUrl: selectedLibraryLocation.referenceImageUrl ?? '',
        description: selectedLibraryLocation.description ?? undefined,
      },
      {
        onSuccess: () => {
          setIsConfirmOpen(false);
          setSelectedLibraryLocation(null);
        },
      }
    );
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-destructive">Failed to load location</p>
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

  if (!location) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <MapPin className="h-16 w-16 text-muted-foreground/30" />
        <div className="text-center">
          <p className="text-sm font-medium">Location not found</p>
          <Link
            to="/sequences/$id/locations"
            params={{ id: sequenceId }}
            className="mt-2 text-sm text-primary hover:underline"
          >
            Back to locations
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
          to="/sequences/$id/locations"
          params={{ id: sequenceId }}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">{location.name}</h1>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-6 p-4">
          {locationDivergentVariant && (
            <SheetStalenessBanners
              entityType="location"
              divergentVariantId={locationDivergentVariant.id}
              onCompareDivergent={() =>
                setCompareVariant(locationDivergentVariant)
              }
              onPromoteDivergent={() => handlePromote(locationDivergentVariant)}
              onDiscardDivergent={() =>
                handleDiscardWithUndo(locationDivergentVariant)
              }
            />
          )}

          {/* Location reference image - 16:9 aspect ratio */}
          <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
            {location.referenceImageUrl && !isSheetGenerating ? (
              <AppImage
                src={location.referenceImageUrl}
                alt={location.name}
                width={160}
                height={160}
                className="h-full w-full object-cover"
              />
            ) : isSheetGenerating ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Regenerating location reference…
                </p>
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <MapPin className="h-20 w-20 text-muted-foreground/20" />
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
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
              {isSheetGenerating ? 'Regenerating...' : 'Update Reference'}
            </Button>
            {/* Manual reference inject (#1108 Phase 4) — no generation. */}
            <UploadMediaButton
              label="Upload Reference"
              pendingLabel="Uploading…"
              accept="image/*"
              isPending={uploadReference.isPending}
              disabled={isSheetGenerating}
              onFile={(file) =>
                uploadReference.mutate(
                  { file, sequenceId, locationDbId: locationId },
                  {
                    onSuccess: () =>
                      toast.success('Location reference uploaded'),
                    onError: (error) =>
                      toast.error('Reference upload failed', {
                        description: errorMessage(error),
                      }),
                  }
                )
              }
              className="flex-1"
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

          <AlertDialog
            open={isRemoveConfirmOpen}
            onOpenChange={setIsRemoveConfirmOpen}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove {location.name} from this sequence?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  The location is hidden from the sequence and prompt context.
                  You can undo from the toast right after removing.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={softDelete.isPending}
                  onClick={() => handleRemove(location.name)}
                >
                  {softDelete.isPending ? 'Removing…' : 'Remove'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Location picker dialog */}
          <LocationPickerDialog
            open={isPickerOpen}
            onOpenChange={setIsPickerOpen}
            onSelect={handleLibraryLocationSelect}
            excludeLocationId={locationId}
          />

          {/* Recast confirmation dialog */}
          {selectedLibraryLocation && (
            <LocationRecastConfirmDialog
              open={isConfirmOpen}
              onOpenChange={setIsConfirmOpen}
              onConfirm={handleRecastConfirm}
              locationName={location.name}
              libraryLocationName={selectedLibraryLocation.name}
              affectedShotCount={shotData?.count ?? 0}
              isLoading={recastLocation.isPending}
            />
          )}

          {/* Location status */}
          <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Location Reference
              </p>
              <p className="text-sm text-muted-foreground">
                Auto-generated from script
              </p>
            </div>
            {shotData && shotData.count > 0 && (
              <div className="text-right">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Used In
                </p>
                <p className="text-sm font-medium">
                  {shotData.count} shot{shotData.count === 1 ? '' : 's'}
                </p>
              </div>
            )}
          </div>

          {/* Editable location bible (#1108 Phase 2). Keyed by id so
              switching locations reseeds the uncontrolled inputs. */}
          <LocationBibleForm
            key={location.id}
            sequenceId={sequenceId}
            location={location}
          />

          {/* First mention (read-only script provenance) */}
          {location.firstMentionSceneId && (
            <div className="space-y-1 rounded-lg bg-muted/50 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                First Appears
              </p>
              <p className="text-sm">
                Scene {location.firstMentionSceneId}
                {location.firstMentionLine &&
                  `, Line ${location.firstMentionLine}`}
              </p>
              {location.firstMentionText && (
                <p className="mt-2 border-l-2 border-muted-foreground/30 pl-3 text-xs italic text-muted-foreground">
                  "{location.firstMentionText}"
                </p>
              )}
            </div>
          )}

          {/* Consistency tag — read-only: renaming it would orphan the scene
              continuity tags that reference it. */}
          {location.consistencyTag && (
            <div className="pt-2">
              <span className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                {location.consistencyTag}
              </span>
            </div>
          )}
        </div>
      </ScrollArea>

      {compareVariant && (
        <SheetComparisonDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setCompareVariant(null);
          }}
          entityType="location"
          livePrimaryUrl={location.referenceImageUrl}
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
