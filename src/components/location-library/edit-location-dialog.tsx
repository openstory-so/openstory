import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SheetComparisonDialog } from '@/components/sheets/sheet-comparison-dialog';
import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  libraryLocationSheetVariantKeys,
  useDiscardLibraryLocationSheetVariant,
  useLibraryLocationDivergentVariants,
  usePromoteLibraryLocationSheetVariant,
  useUndiscardLibraryLocationSheetVariant,
} from '@/hooks/use-library-location-sheet-variants';
import {
  useUpdateLibraryLocation,
  type LibraryLocationWithSheets,
} from '@/hooks/use-location-library';
import type { LocationSheetVariant } from '@/lib/db/schema';
import { useSheetStaleDetected } from '@/components/realtime/use-sheet-stale-detected';

type EditLocationDialogProps = {
  location: LibraryLocationWithSheets;
  trigger?: React.ReactNode;
};

export const EditLocationDialog: React.FC<EditLocationDialogProps> = ({
  location,
  trigger,
}) => {
  const [open, setOpen] = useState(false);
  const updateLocation = useUpdateLibraryLocation();

  const { data: divergentVariants } = useLibraryLocationDivergentVariants();
  const invalidateDivergentKeys = useCallback(
    () => [libraryLocationSheetVariantKeys.divergent()],
    []
  );
  useSheetStaleDetected({
    channelId: open ? `location:${location.id}` : undefined,
    entityTypes: ['library-location'],
    invalidateKeys: invalidateDivergentKeys,
  });
  const promoteVariant = usePromoteLibraryLocationSheetVariant();
  const discardVariant = useDiscardLibraryLocationSheetVariant();
  const undiscardVariant = useUndiscardLibraryLocationSheetVariant();
  const [compareVariant, setCompareVariant] =
    useState<LocationSheetVariant | null>(null);

  const focusVariant = useMemo(() => {
    if (!divergentVariants) return undefined;
    return divergentVariants.find((v) => v.parentId === location.id);
  }, [divergentVariants, location.id]);

  const handleDiscardWithUndo = useCallback(
    (variant: LocationSheetVariant) => {
      const restore = () =>
        undiscardVariant.mutate(
          { variantId: variant.id },
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
        { variantId: variant.id },
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
    [discardVariant, undiscardVariant]
  );

  const handlePromote = useCallback(
    (variant: LocationSheetVariant) => {
      promoteVariant.mutate(
        { variantId: variant.id },
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
    [promoteVariant]
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const nameValue = formData.get('name');
    const descriptionValue = formData.get('description');

    const name = typeof nameValue === 'string' ? nameValue : '';
    const description =
      typeof descriptionValue === 'string' ? descriptionValue : '';

    if (!name.trim()) return;

    updateLocation.mutate(
      {
        locationId: location.id,
        name: name.trim(),
        description: description.trim() || undefined,
      },
      {
        onSuccess: () => setOpen(false),
      }
    );
  };

  const isPending = updateLocation.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Edit Location</DialogTitle>
            <DialogDescription>Update the location details.</DialogDescription>
          </DialogHeader>

          {focusVariant && (
            <SheetStalenessBanners
              entityType="library-location"
              divergentVariantId={focusVariant.id}
              onCompareDivergent={() => setCompareVariant(focusVariant)}
              onPromoteDivergent={() => handlePromote(focusVariant)}
              onDiscardDivergent={() => handleDiscardWithUndo(focusVariant)}
            />
          )}

          <div className="grid gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                defaultValue={location.name}
                autoComplete="off"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                name="description"
                defaultValue={location.description ?? ''}
                placeholder="Describe the location's visual details…"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>

        {compareVariant && (
          <SheetComparisonDialog
            open={true}
            onOpenChange={(o) => {
              if (!o) setCompareVariant(null);
            }}
            entityType="library-location"
            livePrimaryUrl={location.referenceImageUrl}
            variantUrl={compareVariant.url}
            variantId={compareVariant.id}
            onPromote={() => handlePromote(compareVariant)}
            onDiscard={() => handleDiscardWithUndo(compareVariant)}
            isPromoting={promoteVariant.isPending}
            isDiscarding={discardVariant.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
