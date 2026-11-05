import { describeUploadFn } from '@/cast/describe-upload.fn';
import { errorMessage } from '@/platform/errors';
import { useUploadDraftCharacterSheet } from '@/shots/ui/use-media-upload';
import { Button } from '@/ui/shadcn/button';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  FileUploadTrigger,
  type FileUploadProps,
} from '@/ui/shadcn/file-upload';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import { getFileKey } from '@/ui/upload';
import { Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const newCharacterSchema = z.object({
  name: z.string().trim().min(1).max(255),
  physicalDescription: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || undefined),
});

/** What the dropped image turned out to be, once uploaded, checked and described. */
export type CharacterImage = {
  url: string;
  isCharacterSheet: boolean;
  description: string;
};

export type NewCharacterFields = z.output<typeof newCharacterSchema> & {
  /**
   * Still running when Create is pressed: the character is made at once and
   * `useNewCharacter` finishes the image after. Rejects when the upload, the
   * check or the description fails.
   */
  image?: Promise<CharacterImage>;
};

/**
 * A new character (#2254): a name, and optionally a description and a photo
 * or sheet. The image is uploaded, checked for a real person and described
 * in the background; Create never waits for it. The description fills a
 * blank one while the form is open. One form for the cast panel, the Cast
 * picker and the Characters page; `useNewCharacter` makes it.
 */
export const NewCharacterForm: React.FC<{
  isPending: boolean;
  onSubmit: (fields: NewCharacterFields) => void;
  /** The first edit, so the dialog can ask before it is thrown away. */
  onEdit: () => void;
}> = ({ isPending, onSubmit, onEdit }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  // The dropped image's pipeline; null with no image.
  const image = useRef<Promise<CharacterImage> | null>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const uploadSheet = useUploadDraftCharacterSheet();

  const onUpload: NonNullable<FileUploadProps['onUpload']> = (
    [file],
    { onProgress, onSuccess, onError }
  ) => {
    if (!file) return;
    const pipeline = async (): Promise<CharacterImage> => {
      const url = await uploadSheet.mutateAsync({
        file,
        onProgress: (percent) => onProgress(file, percent),
      });
      if (image.current === run) onSuccess(file);
      const result = await describeUploadFn({
        data: { url, filename: file.name, subject: 'character' },
      });
      // A description the user typed is theirs; a removed image's is not used.
      if (
        image.current === run &&
        description.current &&
        !description.current.value.trim()
      ) {
        description.current.value = result.description;
      }
      return {
        url,
        isCharacterSheet: result.isCharacterSheet === true,
        description: result.description,
      };
    };
    const run = pipeline();
    image.current = run;
    setImageBusy(true);
    run
      .catch((error: unknown) => {
        if (image.current === run) {
          onError(file, new Error(errorMessage(error)));
        }
      })
      .finally(() => {
        if (image.current === run) setImageBusy(false);
      });
  };

  const submit = (form: HTMLFormElement) => {
    const result = newCharacterSchema.safeParse(
      Object.fromEntries(new FormData(form))
    );
    if (!result.success) {
      toast.error('Check the character', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    onSubmit({ ...result.data, image: image.current ?? undefined });
  };

  return (
    <form
      onInput={onEdit}
      onSubmit={(event) => {
        event.preventDefault();
        // The Cast picker sits inside the new-sequence form.
        event.stopPropagation();
        submit(event.currentTarget);
      }}

      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-character-name">Name</Label>
        <Input
          id="new-character-name"
          name="name"
          autoComplete="off"
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-character-description">Description</Label>
        <Textarea
          ref={description}
          id="new-character-description"
          name="physicalDescription"
          rows={3}
          maxLength={2000}
          placeholder={
            imageBusy ? 'Describing the image…' : 'Age, build, face, hair'
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label>Photo or sheet</Label>
        <FileUpload
          accept="image/*"
          maxFiles={1}
          disabled={isPending}
          value={files}
          onValueChange={(next) => {
            setFiles(next);
            if (next.length > 0) onEdit();
            else {
              image.current = null;
              setImageBusy(false);
            }
          }}
          onUpload={onUpload}
        >
          {files.length === 0 && (
            <FileUploadDropzone className="min-h-[100px] focus:border-ring/50 focus:bg-accent/30">
              <Upload className="size-7 text-muted-foreground/50" />
              <p className="text-sm font-medium">Drag & drop or paste</p>
              <FileUploadTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  Browse
                </Button>
              </FileUploadTrigger>
            </FileUploadDropzone>
          )}
          <FileUploadList>
            {files.map((file) => (
              <FileUploadItem key={getFileKey(file)} value={file}>
                <FileUploadItemPreview className="size-16" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <FileUploadItemMetadata />
                  <FileUploadItemProgress />
                </div>
                <FileUploadItemDelete asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </FileUploadItemDelete>
              </FileUploadItem>
            ))}
          </FileUploadList>
        </FileUpload>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
};
