import type React from 'react';
import { useRef, useState } from 'react';
import { describeUploadFn } from '@/cast/describe-upload.fn';
import { toast } from 'sonner';
import { z } from 'zod';

import { LocationMediaUpload } from '@/cast/ui/location-library/location-media-upload';
import { useCreateOrganizationLocation } from '@/cast/ui/use-organization-locations';
import { errorMessage } from '@/platform/errors';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import { useHydrated } from '@/ui/use-hydrated';
import { useDiscardGuard } from '@/ui/use-discard-guard';

const newLocationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000),
});

/**
 * Make a location with no sequence (#1695): a name, an optional description
 * and any number of photos. Its sheet is drawn from the photos, or from the
 * description when there are none. A sequence uses it later with @.
 */
export const NewLocationDialog: React.FC<{
  trigger?: React.ReactNode;
  onCreated: (location: { id: string; name: string }) => void;
  /** Photoreal from the Locations page; the picked style's medium from the picker. */
  rendering: () => string;
}> = ({ trigger, onCreated, rendering }) => {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const description = useRef<HTMLTextAreaElement>(null);
  // One description per dialog, even when photos land together; Create waits on it.
  const described = useRef<Promise<void> | null>(null);
  const guard = useDiscardGuard('location');

  // In the background: the first photo fills a blank description; one the user typed is theirs.
  const describe = (photo: { url: string; filename: string }) => {
    if (described.current || description.current?.value.trim()) return;
    setDescribing(true);
    described.current = describeUploadFn({
      data: { ...photo, subject: 'location' },
    })
      .then((result) => {
        if (description.current && !description.current.value.trim()) {
          description.current.value = result.description;
        }
      })
      .catch((error: unknown) => {
        toast.error('Photo not described', {
          description: errorMessage(error),
        });
      })
      .finally(() => setDescribing(false));
  };
  const createLocation = useCreateOrganizationLocation();
  const hydrated = useHydrated();

  const close = () => {
    guard.reset();
    setOpen(false);
    setFiles([]);
    setPhotoUrls([]);
    setUploading(false);
    setDescribing(false);
    described.current = null;
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Opened from inside the create screen's picker, which is a form too.
    event.stopPropagation();
    void submit(event.currentTarget);
  };

  const submit = async (form: HTMLFormElement) => {
    if (described.current) {
      setWaiting(true);
      await described.current;
      setWaiting(false);
    }
    // Read after the wait: the description may have just been filled.
    const result = newLocationSchema.safeParse(
      Object.fromEntries(new FormData(form))
    );
    if (!result.success) {
      toast.error('Check the location fields', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    let renderingText: string;
    try {
      renderingText = rendering();
    } catch (error) {
      toast.error('Location not created', {
        description: errorMessage(error),
      });
      return;
    }
    createLocation.mutate(
      {
        name: result.data.name,
        description: result.data.description || null,
        rendering: renderingText,
        photoUrls,
      },
      {
        onSuccess: (location) => {
          close();
          onCreated(location);
        },
        onError: (error) =>
          toast.error('Location not created', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        next ? setOpen(true) : guard.confirmDiscard(close)
      }
    >
      <DialogTrigger asChild>
        {trigger ?? <Button disabled={!hydrated}>New location</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New location</DialogTitle>
          <DialogDescription>
            Photos are checked for a real person and fill a blank description.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          onInput={guard.markDirty}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-organization-location-name">Name</Label>
            <Input
              id="new-organization-location-name"
              name="name"
              autoComplete="off"
              placeholder="Coffee shop…"
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-organization-location-description">
              Description (optional)
            </Label>
            <Textarea
              ref={description}
              id="new-organization-location-description"
              name="description"
              rows={3}
              placeholder={describing ? 'Describing the photo…' : undefined}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Photos (optional)</Label>
            <LocationMediaUpload
              files={files}
              onFilesChange={(next) => {
                setFiles(next);
                if (next.length > 0) guard.markDirty();
              }}
              onUploadedUrlsChange={setPhotoUrls}
              onUploadingChange={setUploading}
              onPhotoReady={describe}
              disabled={createLocation.isPending}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={createLocation.isPending || uploading || waiting}
            >
              {createLocation.isPending || waiting
                ? 'Creating…'
                : uploading
                  ? 'Uploading…'
                  : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
      {guard.dialog}
    </Dialog>
  );
};
