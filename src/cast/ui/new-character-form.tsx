import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import { Textarea } from '@/ui/shadcn/textarea';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemPreview,
  FileUploadList,
  FileUploadTrigger,
} from '@/ui/shadcn/file-upload';
import { describeUploadFn } from '@/cast/describe-upload.fn';
import { errorMessage } from '@/platform/errors';
import { useUploadDraftCharacterSheet } from '@/shots/ui/use-media-upload';
import {
  FileUploadItemMetadata,
  FileUploadItemProgress,
  type FileUploadProps,
} from '@/ui/shadcn/file-upload';
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
  /**
   * Uploaded, cleared or signed, and described on drop. A sheet is attached
   * as it is; a photo becomes the reference the sheet is drawn from.
   */
  image: z
    .object({ url: z.string(), isCharacterSheet: z.boolean() })
    .optional(),
});

export type NewCharacterFields = z.output<typeof newCharacterSchema>;

/**
 * A new character (#2254): a name, and optionally a description and a photo
 * or sheet. The image is checked for a real person on drop, then described:
 * the description fills a blank one, and says whether it is a sheet. One form for the cast panel, the Cast picker and the
 * Characters page; `useNewCharacter` makes it.
 */
export const NewCharacterForm: React.FC<{
  isPending: boolean;
  onSubmit: (fields: NewCharacterFields) => void;
}> = ({ isPending, onSubmit }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [image, setImage] = useState<NewCharacterFields['image']>();
  const [stage, setStage] = useState<'idle' | 'uploading' | 'describing'>(
    'idle'
  );
  const description = useRef<HTMLTextAreaElement>(null);
  const uploadSheet = useUploadDraftCharacterSheet();

  const onUpload: NonNullable<FileUploadProps['onUpload']> = async (
    [file],
    { onProgress, onSuccess, onError }
  ) => {
    if (!file) return;
    setStage('uploading');
    let url: string;
    try {
      url = await uploadSheet.mutateAsync({
        file,
        onProgress: (percent) => onProgress(file, percent),
      });
    } catch (error) {
      setStage('idle');
      onError(
        file,
        error instanceof Error ? error : new Error('Upload failed')
      );
      return;
    }
    setStage('describing');
    try {
      const result = await describeUploadFn({
        data: { url, filename: file.name, subject: 'character' },
      });
      // A description the user typed is theirs.
      if (description.current && !description.current.value.trim()) {
        description.current.value = result.description;
      }
      setImage({ url, isCharacterSheet: result.isCharacterSheet === true });
      onSuccess(file);
    } catch (error) {
      // Not knowing photo from sheet, Create cannot use it: remove or retry.
      onError(file, new Error(`Image not described: ${errorMessage(error)}`));
    } finally {
      setStage('idle');
    }
  };

  const busy = isPending || stage !== 'idle';
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // The Cast picker sits inside the new-sequence form.
        event.stopPropagation();
        const result = newCharacterSchema.safeParse({
          ...Object.fromEntries(new FormData(event.currentTarget)),
          image,
        });
        if (!result.success) {
          toast.error('Check the character', {
            description: result.error.issues[0]?.message,
          });
          return;
        }
        onSubmit(result.data);
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
          placeholder="Age, build, face, hair"
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
            if (next.length === 0) setImage(undefined);
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
          {isPending
            ? 'Creating…'
            : stage === 'uploading'
              ? 'Uploading…'
              : stage === 'describing'
                ? 'Describing…'
                : 'Create'}
        </Button>
      </div>
    </form>
  );
};
