import { useCallback, useRef } from 'react';
import { Button } from '@/ui/shadcn/button';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  FileUploadTrigger,
  type FileUploadProps,
} from '@/ui/shadcn/file-upload';
import { useUploadLocationPhoto } from '@/cast/ui/use-team-locations';
import { getFileKey } from '@/ui/upload';
import { Upload, X } from 'lucide-react';

type LocationMediaUploadProps = {
  files: File[];
  onFilesChange: (files: File[]) => void;
  /** The stored URLs of the files uploaded so far, cleared or signed. */
  onUploadedUrlsChange: (urls: string[]) => void;
  onUploadingChange: (uploading: boolean) => void;
  disabled: boolean;
};

/**
 * Photos for a location not made yet (#1695): any number, each uploaded as
 * it is dropped. The caller creates the location with the URLs.
 */
export const LocationMediaUpload: React.FC<LocationMediaUploadProps> = ({
  files,
  onFilesChange,
  onUploadedUrlsChange,
  onUploadingChange,
  disabled,
}) => {
  // Stored URL per file. Reported from the handlers that change it, so the
  // parent's list moves with no effect.
  const urlsByFile = useRef(new Map<string, string>());
  const uploadPhoto = useUploadLocationPhoto();

  const handleValueChange = useCallback(
    (newFiles: File[]) => {
      onFilesChange(newFiles);

      // Drop the URLs of removed files.
      const currentKeys = new Set(newFiles.map(getFileKey));
      for (const key of urlsByFile.current.keys()) {
        if (!currentKeys.has(key)) urlsByFile.current.delete(key);
      }
      onUploadedUrlsChange(Array.from(urlsByFile.current.values()));
    },
    [onFilesChange, onUploadedUrlsChange]
  );

  const onUpload: NonNullable<FileUploadProps['onUpload']> = useCallback(
    async (newFiles, { onProgress, onSuccess, onError }) => {
      onUploadingChange(true);
      try {
        await Promise.all(
          newFiles.map(async (file) => {
            try {
              const url = await uploadPhoto.mutateAsync({
                file,
                onProgress: (percent) => onProgress(file, percent),
              });
              urlsByFile.current.set(getFileKey(file), url);
              onUploadedUrlsChange(Array.from(urlsByFile.current.values()));
              onProgress(file, 100);
              onSuccess(file);
            } catch (error) {
              onError(
                file,
                error instanceof Error ? error : new Error('Upload failed')
              );
            }
          })
        );
      } finally {
        onUploadingChange(false);
      }
    },
    [uploadPhoto, onUploadedUrlsChange, onUploadingChange]
  );

  return (
    <FileUpload
      accept="image/*"
      multiple
      disabled={disabled}
      value={files}
      onValueChange={handleValueChange}
      onUpload={onUpload}
    >
      <FileUploadDropzone className="min-h-[120px] focus:border-ring/50 focus:bg-accent/30">
        <Upload className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium">Drag & drop or paste</p>
        <FileUploadTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            Browse files
          </Button>
        </FileUploadTrigger>
      </FileUploadDropzone>

      <FileUploadList className="grid grid-cols-3 gap-3">
        {files.map((file) => (
          <FileUploadItem
            key={getFileKey(file)}
            value={file}
            className="relative aspect-video p-0 border-0 overflow-hidden rounded-lg group"
          >
            <FileUploadItemPreview className="size-full rounded-none border-0" />
            <FileUploadItemProgress className="absolute bottom-0 left-0 right-0 h-1" />
            <FileUploadItemDelete asChild>
              <Button
                type="button"
                variant="destructive"
                size="icon"
                aria-label={`Remove ${file.name}`}
                className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
              >
                <X className="h-4 w-4" />
              </Button>
            </FileUploadItemDelete>
          </FileUploadItem>
        ))}
      </FileUploadList>
    </FileUpload>
  );
};
