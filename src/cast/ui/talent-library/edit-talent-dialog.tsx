import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { SheetComparisonDialog } from '@/cast/ui/sheets/sheet-comparison-dialog';
import { SheetStalenessBanners } from '@/cast/ui/sheets/sheet-staleness-banners';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import {
  talentKeys,
  useAnalyzeTalentMedia,
  useDiscardTalentSheet,
  useSelectTalentSheet,
  useUndiscardTalentSheet,
  useUpdateTalent,
  useDeleteTalentMedia,
} from '@/cast/ui/use-talent';
import { useSheetStaleDetected } from '@/cast/ui/use-sheet-stale-detected';
import { AddTalentMediaDialog } from './add-talent-media-dialog';
import type {
  Talent,
  TalentMediaRecord,
  TalentSheet,
} from '@/platform/server/db/schema';
import { Pencil, Plus, Sparkles, X } from 'lucide-react';
import { AppImage } from '@/ui/shadcn/app-image';

type TalentWithRelations = Talent & {
  sheets: TalentSheet[];
  media: TalentMediaRecord[];
};

type EditTalentDialogProps = {
  talent: TalentWithRelations;
  trigger?: React.ReactNode;
};

/** A run that landed after its claim moved, not yet looked at (#2018). */
export const isParkedSheet = (sheet: TalentSheet): boolean =>
  sheet.divergedAt !== null && sheet.discardedAt === null;

export const EditTalentDialog: React.FC<EditTalentDialogProps> = ({
  talent,
  trigger,
}) => {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(talent.description ?? '');

  const updateTalent = useUpdateTalent();
  const deleteMedia = useDeleteTalentMedia();
  const analyzeMedia = useAnalyzeTalentMedia();

  const invalidateTalent = useCallback(
    () => [talentKeys.detail(talent.id)],
    [talent.id]
  );
  useSheetStaleDetected({
    channelId: open ? `talent:${talent.id}` : undefined,
    entityTypes: ['talent'],
    invalidateKeys: invalidateTalent,
  });
  const selectSheet = useSelectTalentSheet();
  const discardSheet = useDiscardTalentSheet();
  const undiscardSheet = useUndiscardTalentSheet();
  const [compareSheet, setCompareSheet] = useState<TalentSheet | null>(null);

  // The banner offers the oldest parked sheet; the history is on the page.
  const parked = talent.sheets.filter(isParkedSheet);
  const focusSheet = parked.at(-1);
  const referenceUrl =
    talent.sheets.find((s) => s.id === talent.selectedSheetId)?.imageUrl ??
    null;

  const handleDiscardWithUndo = useCallback(
    (sheet: TalentSheet) => {
      const restore = () =>
        undiscardSheet.mutate(
          { sheetId: sheet.id, talentId: talent.id },
          { onSuccess: () => toast.success('Sheet restored') }
        );
      discardSheet.mutate(
        { sheetId: sheet.id, talentId: talent.id },
        {
          onSuccess: () => {
            setCompareSheet(null);
            toast('Sheet discarded', {
              action: { label: 'Undo', onClick: restore },
            });
          },
        }
      );
    },
    [discardSheet, undiscardSheet, talent.id]
  );

  const handleSelect = useCallback(
    (sheet: TalentSheet) => {
      selectSheet.mutate(
        { sheetId: sheet.id, talentId: talent.id },
        {
          onSuccess: () => {
            setCompareSheet(null);
            toast.success('Reference sheet changed');
          },
        }
      );
    },
    [selectSheet, talent.id]
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const text = (key: string) => {
      const value = formData.get(key);
      return typeof value === 'string' ? value.trim() : '';
    };

    const name = text('name');
    if (!name) return;

    updateTalent.mutate(
      {
        talentId: talent.id,
        name,
        description: text('description') || undefined,
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
              A talent is a face: its name, description and reference photos.
              Personality, movement and outfits belong to the characters it
              plays.
            </DialogDescription>
          </DialogHeader>

          {focusSheet && (
            <SheetStalenessBanners
              entityType="talent"
              divergentVariantId={focusSheet.id}
              onCompareDivergent={() => setCompareSheet(focusSheet)}
              onPromoteDivergent={() => handleSelect(focusSheet)}
              onDiscardDivergent={() => handleDiscardWithUndo(focusSheet)}
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
                        aria-label="Remove reference"
                        className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
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

        {compareSheet && (
          <SheetComparisonDialog
            open={true}
            onOpenChange={(o) => {
              if (!o) setCompareSheet(null);
            }}
            entityType="talent"
            livePrimaryUrl={referenceUrl}
            variantUrl={compareSheet.imageUrl}
            variantId={compareSheet.id}
            onPromote={() => handleSelect(compareSheet)}
            onDiscard={() => handleDiscardWithUndo(compareSheet)}
            isPromoting={selectSheet.isPending}
            isDiscarding={discardSheet.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
