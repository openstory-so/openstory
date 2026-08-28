import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
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
} from '@/components/ui/file-upload';
import { Badge } from '@/components/ui/badge';
import { useUploadTalentMedia, useUploadTempMedia } from '@/hooks/use-talent';
import { getFileKey } from '@/lib/utils/upload';
import { Upload, X } from 'lucide-react';

type TalentMediaUploadProps = {
  files: File[];
  onFilesChange: (files: File[]) => void;
  /** Called with URLs when uploading to temp storage (no talentId) */
  onUploadedUrlsChange?: (urls: string[]) => void;
  /** If provided, uploads directly to this talent instead of temp storage */
  talentId?: string;
  /** Required by finalize when uploading onto an existing talent. */
  portraitAttestation?: {
    statementVersion: string;
    authorizationBasis?: string;
  };
  /** Called when all uploads complete (for talentId mode) */
  onComplete?: () => void;
  /** Called after each successful upload with the stored URL. */
  onFileUploaded?: (file: File, url: string) => void;
  /** File keys (see getFileKey) detected as an existing character sheet. */
  sheetFileKeys?: ReadonlySet<string>;
  /** File keys whose sheet-vs-photo classify is still in flight. */
  checkingFileKeys?: ReadonlySet<string>;
  disabled?: boolean;
};

export const TalentMediaUpload: React.FC<TalentMediaUploadProps> = ({
  files,
  onFilesChange,
  onUploadedUrlsChange,
  talentId,
  portraitAttestation,
  onComplete,
  onFileUploaded,
  sheetFileKeys,
  checkingFileKeys,
  disabled = false,
}) => {
  const [uploadedUrlsMap, setUploadedUrlsMap] = useState<Map<string, string>>(
    new Map()
  );
  const uploadedKeysRef = useRef(new Set<string>());
  const pendingBatchesRef = useRef<
    Array<{
      files: File[];
      onProgress: (file: File, percent: number) => void;
      onSuccess: (file: File) => void;
      onError: (file: File, error: Error) => void;
    }>
  >([]);
  const flushingPendingRef = useRef(false);
  const { requireAuth } = useAuthGate();
  const uploadTempMedia = useUploadTempMedia();
  const uploadTalentMedia = useUploadTalentMedia();
  const waitingForAttestation = Boolean(talentId) && !portraitAttestation;

  useEffect(() => {
    onUploadedUrlsChange?.(Array.from(uploadedUrlsMap.values()));
  }, [uploadedUrlsMap, onUploadedUrlsChange]);

  const handleValueChange = useCallback(
    (newFiles: File[]) => {
      onFilesChange(newFiles);
      // Clean up URLs for removed files
      const currentKeys = new Set(newFiles.map(getFileKey));
      setUploadedUrlsMap((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const key of next.keys()) {
          if (!currentKeys.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [onFilesChange]
  );

  const onUpload: NonNullable<FileUploadProps['onUpload']> = useCallback(
    async (newFiles, { onProgress, onSuccess, onError }) => {
      // Uploads hit the server immediately — anonymous visitors get the login
      // prompt instead of a raw upload error.
      if (!requireAuth()) {
        for (const file of newFiles) {
          onError(file, new Error('Sign in to upload'));
        }
        return;
      }
      if (waitingForAttestation) {
        pendingBatchesRef.current.push({
          files: newFiles,
          onProgress,
          onSuccess,
          onError,
        });
        return;
      }
      const uploadPromises = newFiles.map(async (file) => {
        try {
          const type = file.type.startsWith('video/')
            ? ('video' as const)
            : ('image' as const);

          if (talentId) {
            const result = await uploadTalentMedia.mutateAsync({
              talentId,
              file,
              type,
              onProgress: (percent) => onProgress(file, percent),
              portraitAttestation,
            });
            onFileUploaded?.(file, result.url);
          } else {
            const result = await uploadTempMedia.mutateAsync({
              file,
              type,
              onProgress: (percent) => onProgress(file, percent),
            });

            setUploadedUrlsMap((prev) =>
              new Map(prev).set(getFileKey(file), result.url)
            );
            onFileUploaded?.(file, result.url);
          }

          uploadedKeysRef.current.add(getFileKey(file));
          onProgress(file, 100);
          onSuccess(file);
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error('Upload failed');
          onError(file, err);
          throw err;
        }
      });

      const results = await Promise.allSettled(uploadPromises);
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        toast.error(
          failed.length === newFiles.length
            ? 'Upload failed'
            : `${failed.length} of ${newFiles.length} files failed to upload`
        );
        return;
      }
      if (talentId) {
        onComplete?.();
      }
    },
    [
      requireAuth,
      talentId,
      portraitAttestation,
      waitingForAttestation,
      uploadTempMedia,
      uploadTalentMedia,
      onComplete,
      onFileUploaded,
    ]
  );

  useEffect(() => {
    if (files.length === 0) {
      uploadedKeysRef.current.clear();
      pendingBatchesRef.current = [];
    }
  }, [files.length]);

  useEffect(() => {
    if (waitingForAttestation || !talentId || !portraitAttestation) return;
    if (flushingPendingRef.current) return;
    const batches = pendingBatchesRef.current;
    if (batches.length === 0) return;
    pendingBatchesRef.current = [];
    flushingPendingRef.current = true;
    const currentKeys = new Set(files.map(getFileKey));
    void (async () => {
      try {
        for (const batch of batches) {
          const stillPresent = batch.files.filter((file) =>
            currentKeys.has(getFileKey(file))
          );
          if (stillPresent.length === 0) continue;
          await onUpload(stillPresent, {
            onProgress: batch.onProgress,
            onSuccess: batch.onSuccess,
            onError: batch.onError,
          });
        }
      } finally {
        flushingPendingRef.current = false;
      }
    })();
  }, [waitingForAttestation, talentId, portraitAttestation, files, onUpload]);

  return (
    <FileUpload
      accept="image/*,video/*"
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
        <p className="text-xs text-muted-foreground">Images and videos</p>
      </FileUploadDropzone>

      <FileUploadList className="grid grid-cols-3 gap-3">
        {files.map((file) => (
          <FileUploadItem
            key={getFileKey(file)}
            value={file}
            className="relative aspect-square p-0 border-0 overflow-hidden rounded-lg group"
          >
            <FileUploadItemPreview
              className="size-full rounded-none border-0"
              render={(file, fallback) =>
                file.type.startsWith('video/') ? (
                  <video
                    src={URL.createObjectURL(file)}
                    className="size-full object-cover"
                    muted
                  />
                ) : (
                  fallback()
                )
              }
            />
            <FileUploadItemProgress className="absolute bottom-0 left-0 right-0 h-1" />
            {sheetFileKeys?.has(getFileKey(file)) ? (
              <Badge className="absolute bottom-2 left-2">Sheet</Badge>
            ) : checkingFileKeys?.has(getFileKey(file)) ? (
              <Badge variant="secondary" className="absolute bottom-2 left-2">
                Checking…
              </Badge>
            ) : null}
            <FileUploadItemDelete asChild>
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
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

export { type TalentMediaUploadProps };
