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
  talentSheetVariantKeys,
  useDiscardTalentSheetVariant,
  usePromoteTalentSheetVariant,
  useTalentDivergentVariants,
  useUndiscardTalentSheetVariant,
} from '@/hooks/use-talent-sheet-variants';
import {
  useAnalyzeTalentMedia,
  useUpdateTalent,
  useDeleteTalentMedia,
} from '@/hooks/use-talent';
import { useSheetStaleDetected } from '@/lib/realtime/use-sheet-stale-detected';
import { AddTalentMediaDialog } from './add-talent-media-dialog';
import type {
  Talent,
  TalentMediaRecord,
  TalentSheet,
  TalentSheetVariant,
} from '@/lib/db/schema';
import { Pencil, Plus, Sparkles, X } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';

type TalentWithRelations = Talent & {
  sheets: TalentSheet[];
  media: TalentMediaRecord[];
};

type EditTalentDialogProps = {
  talent: TalentWithRelations;
  trigger?: React.ReactNode;
};

export const EditTalentDialog: React.FC<EditTalentDialogProps> = ({
  talent,
  trigger,
}) => {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(talent.description ?? '');

  const updateTalent = useUpdateTalent();
  const deleteMedia = useDeleteTalentMedia();
  const analyzeMedia = useAnalyzeTalentMedia();

  const { data: divergentVariants } = useTalentDivergentVariants(
    open ? talent.id : undefined
  );
  const invalidateDivergentKeys = useCallback(
    () => [talentSheetVariantKeys.divergentByTalent(talent.id)],
    [talent.id]
  );
  useSheetStaleDetected({
    channelId: open ? `talent:${talent.id}` : undefined,
    entityTypes: ['talent'],
    invalidateKeys: invalidateDivergentKeys,
  });
  const promoteVariant = usePromoteTalentSheetVariant();
  const discardVariant = useDiscardTalentSheetVariant();
  const undiscardVariant = useUndiscardTalentSheetVariant();
  const [compareVariant, setCompareVariant] =
    useState<TalentSheetVariant | null>(null);

  // Pick the most relevant divergent variant for the banner: oldest active
  // entry across this talent's sheets (matches the listing order).
  const focusVariant = useMemo(
    () => divergentVariants?.[0],
    [divergentVariants]
  );

  // Live primary url for the focused variant — `talent_sheets.imageUrl` of
  // the parent sheet. Match by id rather than picking the default sheet so
  // the dialog compares against the correct primary slot.
  const focusVariantLiveUrl = useMemo(() => {
    if (!compareVariant) return null;
    const sheet = talent.sheets.find(
      (s) => s.id === compareVariant.talentSheetId
    );
    return sheet?.imageUrl ?? null;
  }, [compareVariant, talent.sheets]);

  const handleDiscardWithUndo = useCallback(
    (variant: TalentSheetVariant) => {
      const restore = () =>
        undiscardVariant.mutate(
          { variantId: variant.id, talentId: talent.id },
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
        { variantId: variant.id, talentId: talent.id },
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
    [discardVariant, undiscardVariant, talent.id]
  );

  const handlePromote = useCallback(
    (variant: TalentSheetVariant) => {
      promoteVariant.mutate(
        { variantId: variant.id, talentId: talent.id },
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
    [promoteVariant, talent.id]
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

    updateTalent.mutate(
      {
        talentId: talent.id,
        name: name.trim(),
        description: description.trim() || undefined,
      },
      {
        onSuccess: () => setOpen(false),
      }
    );
  };

  const handleDeleteMedia = async (mediaId: string) => {
    await deleteMedia.mutateAsync({
      mediaId,
      talentId: talent.id,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDescription(talent.description ?? '');
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="icon" aria-label="Edit talent">
            <Pencil className="h-4 w-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Edit Talent</DialogTitle>
            <DialogDescription>
              Update talent details and reference media.
            </DialogDescription>
          </DialogHeader>

          {focusVariant && (
            <SheetStalenessBanners
              entityType="talent"
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
                defaultValue={talent.name}
                placeholder="Talent name…"
                autoComplete="off"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="description">Description</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    talent.media.filter((m) => m.type === 'image').length ===
                      0 || analyzeMedia.isPending
                  }
                  onClick={() => {
                    const urls = talent.media
                      .filter((m) => m.type === 'image')
                      .map((m) => m.url)
                      .slice(0, 8);
                    analyzeMedia.mutate(
                      { imageUrls: urls },
                      {
                        onSuccess: (result) => {
                          setDescription(result.description);
                          toast.success('Description generated from photos');
                        },
                        onError: (error) => {
                          toast.error('Could not generate description', {
                            description:
                              error instanceof Error
                                ? error.message
                                : 'Unknown error',
                          });
                        },
                      }
                    );
                  }}
                >
                  <Sparkles className="h-4 w-4" />
                  {analyzeMedia.isPending
                    ? 'Generating…'
                    : 'Generate from photos'}
                </Button>
              </div>
              <Textarea
                id="description"
                name="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the talent's appearance, style…"
                rows={3}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Reference Media</Label>
              {talent.media.length > 0 ? (
                <div className="grid grid-cols-3 gap-3">
                  {talent.media.map((media) => (
                    <div
                      key={media.id}
                      className="relative aspect-square rounded-lg overflow-hidden bg-muted group"
                    >
                      {media.type === 'video' ? (
                        <video
                          src={media.url}
                          className="size-full object-cover"
                          muted
                        />
                      ) : (
                        <AppImage
                          src={media.url}
                          alt="Reference"
                          width={160}
                          height={160}
                          className="size-full object-cover"
                        />
                      )}
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => void handleDeleteMedia(media.id)}
                        disabled={deleteMedia.isPending}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No reference media uploaded yet.
                </p>
              )}
              <AddTalentMediaDialog
                talentId={talent.id}
                isHuman={talent.isHuman === true}
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Media
                  </Button>
                }
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={updateTalent.isPending}>
              {updateTalent.isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>

        {compareVariant && (
          <SheetComparisonDialog
            open={true}
            onOpenChange={(o) => {
              if (!o) setCompareVariant(null);
            }}
            entityType="talent"
            livePrimaryUrl={focusVariantLiveUrl}
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
