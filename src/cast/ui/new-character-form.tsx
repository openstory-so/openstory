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

type CharacterImage = { url: string; isCharacterSheet: boolean };

export type NewCharacterFields = z.output<typeof newCharacterSchema> & {
  /**
   * Uploaded, cleared or signed, and described. A sheet is attached as it
   * is; a photo becomes the reference the sheet is drawn from.
   */
  image?: CharacterImage;
};

/**
 * A new character (#2254): a name, and optionally a description and a photo
 * or sheet. The image is checked for a real person on drop, then described
 * in the background, as an element is: the description fills a blank one
 * and says whether the image is a sheet. Create waits only for what it
 * needs. One form for the cast panel, the Cast picker and the Characters
 * page; `useNewCharacter` makes it.
 */
export const NewCharacterForm: React.FC<{
  isPending: boolean;
  onSubmit: (fields: NewCharacterFields) => void;
  /** The first edit, so the dialog can ask before it is thrown away. */
  onEdit: () => void;
}> = ({ isPending, onSubmit, onEdit }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // The image's description, running or done; null with no usable image.
  const described = useRef<Promise<CharacterImage | null> | null>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const uploadSheet = useUploadDraftCharacterSheet();

  const onUpload: NonNullable<FileUploadProps['onUpload']> = async (
    [file],
    { onProgress, onSuccess, onError }
  ) => {
    if (!file) return;
    setUploading(true);
    let url: string;
    try {
      url = await uploadSheet.mutateAsync({
        file,
        onProgress: (percent) => onProgress(file, percent),
      });
    } catch (error) {
      onError(
        file,
        error instanceof Error ? error : new Error('Upload failed')
      );
      return;
    } finally {
      setUploading(false);
    }
    onSuccess(file);
    setDescribing(true);
    const run = describeUploadFn({
      data: { url, filename: file.name, subject: 'character' },
    })
      .then((result): CharacterImage => {
        // A description the user typed is theirs; a removed image's is not used.
        if (
          described.current === run &&
          description.current &&
          !description.current.value.trim()
        ) {
          description.current.value = result.description;
        }
        return { url, isCharacterSheet: result.isCharacterSheet === true };
      })
      .catch((error: unknown) => {
        // Not knowing photo from sheet, Create cannot use it: remove or retry.
        onError(file, new Error(`Not described: ${errorMessage(error)}`));
        return null;
      })
      .finally(() => {
        if (described.current === run) setDescribing(false);
      });
    described.current = run;
  };

  const submit = async (form: HTMLFormElement) => {
    let image: CharacterImage | undefined;
    if (described.current) {
      setWaiting(true);
      const result = await described.current;
      setWaiting(false);
      if (!result) {
        toast.error('Remove the image or drop it again');
        return;
      }
      image = result;
    }
    // Read after the wait: the description may have just been filled.
    const result = newCharacterSchema.safeParse(
      Object.fromEntries(new FormData(form))
    );
    if (!result.success) {
      toast.error('Check the character', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    onSubmit({ ...result.data, image });
  };

  const busy = isPending || uploading || waiting;
  return (
    <form
      onInput={onEdit}
      onSubmit={(event) => {
        event.preventDefault();
        // The Cast picker sits inside the new-sequence form.
        event.stopPropagation();
        void submit(event.currentTarget);
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
            describing ? 'Describing the image…' : 'Age, build, face, hair'
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
          disabled={busy}
          value={files}
          onValueChange={(next) => {
            setFiles(next);
            if (next.length > 0) onEdit();
            else {
              described.current = null;
              setDescribing(false);
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
        <Button type="submit" disabled={busy}>
          {isPending || waiting
            ? 'Creating…'
            : uploading
              ? 'Uploading…'
              : 'Create'}
        </Button>
      </div>
    </form>
  );
};
