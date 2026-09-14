import { useState } from 'react';
import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
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
import { useHydrated } from '@/ui/use-hydrated';
import { useCreateLibraryLocation } from '@/cast/ui/use-location-library';
import type { LibraryLocation } from '@/platform/server/db/schema';
import { Plus } from 'lucide-react';
import { LocationMediaUpload } from './location-media-upload';

type AddLocationDialogProps = {
  trigger?: React.ReactNode;
  /** Called with the newly created location so callers can auto-select it. */
  onCreated?: (location: LibraryLocation) => void;
};

export const AddLocationDialog: React.FC<AddLocationDialogProps> = ({
  trigger,
  onCreated,
}) => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [isFileUploading, setIsFileUploading] = useState(false);

  const isHydrated = useHydrated();
  const { requireAuth } = useAuthGate();
  const createLocation = useCreateLibraryLocation();

  const closeAndReset = () => {
    setFiles([]);
    setUploadedUrls([]);
    setIsFileUploading(false);
    setOpen(false);
  };

  const handleClose = () => {
    if (
      files.length > 0 &&
      !window.confirm(
        'Discard uploaded reference images? Your uploads will be lost.'
      )
    ) {
      return;
    }
    closeAndReset();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // Anonymous visitors can open the dialog and fill the form; the actual
    // add prompts a login.
    if (!requireAuth()) return;

    const formData = new FormData(e.currentTarget);
    const nameValue = formData.get('name');
    const descriptionValue = formData.get('description');

    const name = typeof nameValue === 'string' ? nameValue : '';
    const description =
      typeof descriptionValue === 'string' ? descriptionValue : '';

    if (!name.trim()) return;

    createLocation.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        referenceImageUrls: uploadedUrls.length > 0 ? uploadedUrls : undefined,
      },
      {
        onSuccess: (location) => {
          onCreated?.(location);
          closeAndReset();
        },
      }
    );
  };

  const isPending = createLocation.isPending;
  const isUploading = isFileUploading;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button disabled={!isHydrated}>
            <Plus className="mr-2 h-4 w-4" />
            Add Location
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-w-lg"
        onPointerDownOutside={(e) => {
          if (files.length > 0) {
            e.preventDefault();
            handleClose();
          }
        }}
        onEscapeKeyDown={(e) => {
          if (files.length > 0) {
            e.preventDefault();
            handleClose();
          }
        }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Add Location</DialogTitle>
            <DialogDescription>
              Add a location to your library. Upload reference images to
              maintain visual consistency across sequences.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                placeholder="Coffee Shop, City Park, Office Building…"
                autoComplete="off"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                name="description"
                placeholder="Describe the location's visual details…"
                rows={3}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Reference Images</Label>
              <LocationMediaUpload
                files={files}
                onFilesChange={setFiles}
                onUploadedUrlsChange={setUploadedUrls}
                onUploadingChange={setIsFileUploading}
                disabled={isPending}
                maxFiles={5}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || isUploading}>
              {isPending
                ? 'Creating…'
                : isUploading
                  ? 'Uploading…'
                  : 'Add Location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
