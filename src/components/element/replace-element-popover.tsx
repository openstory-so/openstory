import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useReplaceSequenceElement } from '@/hooks/use-sequence-elements';
import { cn } from '@/lib/utils';
import {
  extractImagesFromSnapshot,
  snapshotDataTransfer,
  toastDragImportCorsError,
} from '@/lib/utils/drag-images';
import { Loader2, RefreshCw, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type ReplaceElementPopoverProps = {
  sequenceId: string;
  elementId: string;
  token: string;
  affectedShotCount: number;
  affectedVideoCount: number;
  disabled?: boolean;
  /** Labeled button on the detail page; icon-only in compact cards. */
  trigger?: 'icon' | 'button';
};

/**
 * Replace one element's image. Two-step flow inside a single popover:
 *
 *  1. Dropzone — drag/drop, paste, or browse for a new image. Nothing
 *     destructive runs yet.
 *  2. Confirmation — shows the picked file with an explicit "Replace" button
 *     before any upload starts. Affected shots are left stale.
 *
 * The upload + vision re-run only fires once the user confirms; the popover
 * stays open and shows an uploading state until the mutation resolves, then
 * closes.
 */
export const ReplaceElementPopover: React.FC<ReplaceElementPopoverProps> = ({
  sequenceId,
  elementId,
  token,
  affectedShotCount,
  affectedVideoCount,
  disabled = false,
  trigger = 'icon',
}) => {
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceMutation = useReplaceSequenceElement();

  // Object URL for the picked file. Created on selection, revoked when the
  // file changes, the popover closes, or the component unmounts — otherwise
  // each re-pick would leak a blob.
  useEffect(() => {
    if (!pendingFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [pendingFile]);

  // Reset the staged file whenever the popover closes so a stale pick from a
  // previous open doesn't reappear when the user comes back.
  useEffect(() => {
    if (!open) setPendingFile(null);
  }, [open]);

  const clearPending = useCallback(() => {
    setPendingFile(null);
  }, []);

  const handleFiles = useCallback((files: File[]) => {
    const image = files.find((f) => f.type.startsWith('image/'));
    if (!image) return;
    setPendingFile(image);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!pendingFile) return;
    replaceMutation.mutate(
      { file: pendingFile, sequenceId, elementId },
      {
        onSuccess: () => {
          setOpen(false);
          setPendingFile(null);
          toast.success(`Replaced ${token}`, {
            description:
              affectedShotCount > 0
                ? `${affectedShotCount} shot${affectedShotCount === 1 ? '' : 's'} will show as out of date`
                : undefined,
          });
        },
        onError: (err) => {
          toast.error('Failed to replace element', {
            description: err instanceof Error ? err.message : 'Unknown error',
          });
        },
      }
    );
  }, [
    affectedShotCount,
    elementId,
    pendingFile,
    replaceMutation,
    sequenceId,
    token,
  ]);

  const isPending = replaceMutation.isPending;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Block dismiss while the upload + workflow trigger is in-flight so
        // the user can't navigate away mid-mutation and leave the element
        // stranded in `analyzing` without UI feedback.
        if (isPending && !next) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        {trigger === 'button' ? (
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={disabled}
            aria-label={`Replace ${token} image`}
          >
            <RefreshCw className="h-4 w-4" />
            Replace image
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={`Replace ${token} image`}
            title="Replace image"
          >
            <RefreshCw className="size-4" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px]">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              Replace <span className="font-mono">{token}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {pendingFile
                ? affectedShotCount > 0
                  ? `This replaces the reference. ${affectedShotCount} shot${affectedShotCount === 1 ? '' : 's'}${
                      affectedVideoCount > 0
                        ? ` (${affectedVideoCount} with video)`
                        : ''
                    } that use it will show as out of date until you update them.`
                  : `This replaces the reference image for ${token}.`
                : `Drop a new image to replace ${token}. You'll get a chance to confirm before anything changes.`}
            </p>
          </div>

          {pendingFile && previewUrl ? (
            <div className="flex flex-col gap-3">
              <div className="relative aspect-video overflow-hidden rounded-md border bg-muted">
                {/* Local object-URL preview — not a remote asset. */}
                {/* biome-ignore lint/performance/noImgElement: blob: preview */}
                <img
                  src={previewUrl}
                  alt={pendingFile.name}
                  className="size-full object-contain"
                />
                {!isPending && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute top-1 right-1 size-6"
                    onClick={clearPending}
                    aria-label="Choose a different image"
                  >
                    <X className="size-3" />
                  </Button>
                )}
              </div>
              <p
                className="truncate text-xs text-muted-foreground"
                title={pendingFile.name}
              >
                {pendingFile.name}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearPending}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={isPending}
                >
                  {isPending && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  <span>{isPending ? 'Replacing…' : `Replace ${token}`}</span>
                </Button>
              </div>
            </div>
          ) : (
            <div
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- dropzone cannot be a <button> because it contains a nested <Button>
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                const related = e.relatedTarget;
                if (
                  related instanceof Node &&
                  e.currentTarget.contains(related)
                ) {
                  return;
                }
                setDragOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const snapshot = snapshotDataTransfer(e.dataTransfer);
                void extractImagesFromSnapshot(snapshot).then(
                  ({ files, failedUrls }) => {
                    if (files.length > 0) {
                      handleFiles(files);
                    } else if (failedUrls.length > 0) {
                      toastDragImportCorsError();
                    }
                  }
                );
              }}
              onPaste={(e) => {
                const items = e.clipboardData.items;
                const pasted: File[] = [];
                for (const item of items) {
                  if (item.kind === 'file') {
                    const file = item.getAsFile();
                    if (file) pasted.push(file);
                  }
                }
                if (pasted.length === 0) return;
                e.preventDefault();
                handleFiles(pasted);
              }}
              className={cn(
                'relative flex select-none flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-5 min-h-[100px] outline-none transition-colors hover:bg-accent/30 focus-visible:border-ring/50 cursor-pointer',
                dragOver && 'border-primary/50 bg-accent/30'
              )}
            >
              <Upload className="size-6 text-muted-foreground/50" />
              <span className="text-sm font-medium">Drag & drop or paste</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                Browse
              </Button>
            </div>
          )}

          {!pendingFile && (
            <p className="text-[11px] text-muted-foreground">
              Vision will re-analyze the new image and may rename {token} if a
              better identifier is visible.
            </p>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            handleFiles(files);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};
