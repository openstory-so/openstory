/**
 * Element selector for the sequence creation + edit forms.
 *
 * Two modes:
 *  - draft (default): files upload to a temp R2 path and land in the parent's
 *    `draftElements` list via onDraftElementsChange. The parent list is the
 *    canonical state (it's what localStorage draft persistence restores after
 *    a reload — #1079); local entries here only track in-flight uploads and
 *    errors. Used on new-sequence creation before the sequence exists.
 *  - persisted: when a sequenceId is provided, files upload directly into that
 *    sequence's elements (useSequenceElements) and can be deleted.
 *
 * Both modes let the user rename an element's token in place (#1079).
 *
 * Exposes an imperative ref so external drop targets (ScriptView) can inject
 * files.
 */

import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ElementTokenButton } from '@/components/element/element-token-button';
import {
  restoreSequenceElement,
  useDeleteSequenceElement,
  useRenameSequenceElementToken,
  useSequenceElements,
  useUploadDraftElement,
  useUploadElementToSequence,
  type DraftElementUpload,
} from '@/hooks/use-sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { errorMessage } from '@/lib/errors';
import { MAX_SEQUENCE_ELEMENTS } from '@/lib/sequence-elements/limits';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import {
  extractImagesFromSnapshot,
  snapshotDataTransfer,
  toastDragImportCorsError,
} from '@/lib/utils/drag-images';
import { getFileKey } from '@/lib/utils/upload';
import { ImagePlus, Loader2, Upload, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { getLogger } from '@/lib/observability/logger';
import { AppImage } from '@/components/ui/app-image';

const logger = getLogger(['openstory', 'ui', 'element', 'element-selector']);

export type ElementSelectorHandle = {
  addFiles: (files: File[]) => void;
  open: () => void;
};

type BaseProps = {
  ref?: React.Ref<ElementSelectorHandle>;
  disabled?: boolean;
  /**
   * Fires `true` while at least one element is uploading *or* still being
   * vision-analyzed (draft mode: the inline analyzeDraftElementFn call;
   * persisted mode: the async element-vision workflow's pending/analyzing
   * states). Parent forms gate their submit button on this so we never hand
   * the script-analyze workflow a token whose visual description hasn't
   * landed yet — that path produces the `(vision description pending)`
   * placeholder downstream.
   */
  onElementBusyChange?: (busy: boolean) => void;
};

type DraftModeProps = BaseProps & {
  sequenceId?: undefined;
  draftElements: DraftElementUpload[];
  onDraftElementsChange: (next: DraftElementUpload[]) => void;
  /**
   * Fires after a draft element's token is renamed so the parent can rewrite
   * references in the script text (the persisted path does the same
   * server-side via cascadeRename).
   */
  onDraftTokenRename?: (oldToken: string, newToken: string) => void;
};

type PersistedModeProps = BaseProps & {
  sequenceId: string;
  draftElements?: undefined;
  onDraftElementsChange?: undefined;
  onDraftTokenRename?: undefined;
};

type ElementSelectorProps = DraftModeProps | PersistedModeProps;

type LocalEntry = {
  file: File;
  previewUrl: string;
  status: 'uploading' | 'analyzing' | 'done' | 'error';
  errorMessage?: string;
};

/**
 * Pick which incoming files to accept: element-count cap and duplicate-key
 * filtering, pure so `processFiles` can run it before touching state. It must
 * NOT run inside the setEntries updater — updaters aren't guaranteed to run
 * before the code that follows the setState call, and an `accepted` list built
 * inside one can still be empty when the uploads are started from it,
 * stranding entries in `uploading` forever and locking the Generate button on
 * "Analyzing elements…" (#1231).
 */
export function selectFilesToAccept(
  files: File[],
  existingKeys: ReadonlySet<string>,
  existingCount: number
): { key: string; file: File }[] {
  const accepted: { key: string; file: File }[] = [];
  const seen = new Set(existingKeys);
  let remaining = MAX_SEQUENCE_ELEMENTS - existingCount;
  for (const file of files) {
    if (remaining <= 0) break;
    const key = getFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ key, file });
    remaining--;
  }
  return accepted;
}

type DisplayItem = {
  key: string;
  imageUrl: string;
  token?: string;
  status: 'uploading' | 'analyzing' | 'done' | 'error';
  errorMessage?: string;
};

export const ElementSelector: React.FC<ElementSelectorProps> = (props) => {
  const {
    ref,
    disabled = false,
    sequenceId,
    draftElements,
    onDraftElementsChange,
    onDraftTokenRename,
    onElementBusyChange,
  } = props;
  const isPersisted = !!sequenceId;

  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Map<string, LocalEntry>>(new Map());
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { requireAuth } = useAuthGate();
  const draftUpload = useUploadDraftElement();
  const sequenceUpload = useUploadElementToSequence();
  const deleteElement = useDeleteSequenceElement();
  const queryClient = useQueryClient();
  const renameToken = useRenameSequenceElementToken();
  const { data: persistedElements = [] } = useSequenceElements(
    isPersisted ? sequenceId : undefined
  );

  // Mirror of the parent's canonical draft list, updated synchronously on our
  // own emissions so two uploads completing in the same tick don't lose the
  // first append (the prop only catches up on the parent's next render).
  const draftElementsRef = useRef<DraftElementUpload[]>(draftElements ?? []);
  draftElementsRef.current = draftElements ?? [];

  const emitDraftElements = useCallback(
    (next: DraftElementUpload[]) => {
      draftElementsRef.current = next;
      onDraftElementsChange?.(next);
    },
    [onDraftElementsChange]
  );

  const hasInflightLocalEntry = useMemo(
    () =>
      Array.from(entries.values()).some(
        (e) => e.status === 'uploading' || e.status === 'analyzing'
      ),
    [entries]
  );

  const hasPendingPersistedVision = useMemo(
    () =>
      isPersisted &&
      persistedElements.some(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      ),
    [isPersisted, persistedElements]
  );

  const isBusy = hasInflightLocalEntry || hasPendingPersistedVision;

  useEffect(() => {
    onElementBusyChange?.(isBusy);
  }, [isBusy, onElementBusyChange]);

  // Reconciled after commit (not during render): a discarded or lower-priority
  // render pass can carry an `entries` value that predates keys `processFiles`
  // just pushed into the mirror, and a render-phase write would clobber them —
  // resurrecting the stuck-upload bug this mirror exists to prevent (#1231).
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  });

  // Persisted mode: once an upload's element row lands in the query data,
  // drop the transient local entry (its tile is superseded by the real one).
  useEffect(() => {
    if (!isPersisted || persistedElements.length === 0) return;
    const persistedFilenames = new Set(
      persistedElements.map((el) => el.uploadedFilename)
    );
    setEntries((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [key, entry] of prev) {
        if (
          entry.status === 'done' &&
          persistedFilenames.has(entry.file.name)
        ) {
          URL.revokeObjectURL(entry.previewUrl);
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [isPersisted, persistedElements]);

  useEffect(() => {
    return () => {
      for (const entry of entriesRef.current.values()) {
        URL.revokeObjectURL(entry.previewUrl);
      }
    };
  }, []);

  const currentCount = isPersisted
    ? persistedElements.length + entries.size
    : (draftElements?.length ?? 0) + entries.size;

  const removeLocalEntry = useCallback((key: string) => {
    setEntries((prev) => {
      const current = prev.get(key);
      if (!current) return prev;
      URL.revokeObjectURL(current.previewUrl);
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const processFiles = useCallback(
    async (newFiles: File[]) => {
      if (disabled) return;
      const images = newFiles.filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return;

      // Uploads hit the server immediately — anonymous visitors get the login
      // prompt instead (covers browse, drop, paste, and external drops).
      if (!requireAuth()) return;

      // Accept files BEFORE touching state (see selectFilesToAccept). The ref
      // mirror is what this function reads synchronously for keys/counts; the
      // state updater below stays pure and merges the same entries.
      const currentEntries = entriesRef.current;
      const existingCount = isPersisted
        ? persistedElements.length + currentEntries.size
        : draftElementsRef.current.length + currentEntries.size;
      const accepted = selectFilesToAccept(
        images,
        new Set(currentEntries.keys()),
        existingCount
      );
      if (accepted.length === 0) return;

      const seeded = new Map(currentEntries);
      for (const { key, file } of accepted) {
        seeded.set(key, {
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'uploading',
        });
      }
      // Sync the mirror now so a second processFiles call in the same tick
      // sees these keys (state only catches up on the next render).
      entriesRef.current = seeded;
      setEntries((prev) => {
        const next = new Map(prev);
        for (const { key } of accepted) {
          const entry = seeded.get(key);
          if (entry && !next.has(key)) next.set(key, entry);
        }
        return next;
      });

      await Promise.all(
        accepted.map(async ({ key, file }) => {
          try {
            if (isPersisted) {
              await sequenceUpload.mutateAsync({ file, sequenceId });
              // Success — local entry kept until query refetches, then cleared
              setEntries((prev) => {
                const current = prev.get(key);
                if (!current) return prev;
                const next = new Map(prev);
                next.set(key, { ...current, status: 'done' });
                return next;
              });
            } else {
              const result = await draftUpload.mutateAsync({
                file,
                onAnalyzingChange: (analyzing) => {
                  setEntries((prev) => {
                    const current = prev.get(key);
                    if (!current) return prev;
                    // Don't downgrade out of error/done if a slow analyze
                    // callback fires after the mutation already settled.
                    if (
                      current.status !== 'uploading' &&
                      current.status !== 'analyzing'
                    ) {
                      return prev;
                    }
                    const next = new Map(prev);
                    next.set(key, {
                      ...current,
                      status: analyzing ? 'analyzing' : current.status,
                    });
                    return next;
                  });
                },
              });
              // Promote into the parent's canonical draft list and drop the
              // transient local entry — unless the user removed it mid-upload,
              // in which case the result is discarded.
              if (entriesRef.current.has(key)) {
                removeLocalEntry(key);
                emitDraftElements([...draftElementsRef.current, result]);
              }
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Upload failed';
            logger.error('Upload failed', {
              filename: file.name,
              error: err,
            });
            toast.error(`Couldn't upload ${file.name}`, {
              description: message,
            });
            setEntries((prev) => {
              const current = prev.get(key);
              if (!current) return prev;
              const next = new Map(prev);
              next.set(key, {
                ...current,
                status: 'error',
                errorMessage: message,
              });
              return next;
            });
          }
        })
      );
    },
    [
      disabled,
      requireAuth,
      isPersisted,
      persistedElements.length,
      sequenceId,
      draftUpload,
      sequenceUpload,
      removeLocalEntry,
      emitDraftElements,
    ]
  );

  // Soft-remove with a 60s undo toast (#1108 Phase 2). The undo closure
  // survives this component's unmount — restoreSequenceElement works on the
  // app-level query client, not a mutation observer.
  const removePersistedElement = useCallback(
    (element: SequenceElement) => {
      if (!isPersisted) return;
      deleteElement.mutate(
        { elementId: element.id, sequenceId },
        {
          onSuccess: () => {
            toast(`Removed ${element.token}`, {
              duration: 60_000,
              action: {
                label: 'Undo',
                onClick: () =>
                  void restoreSequenceElement(queryClient, {
                    sequenceId,
                    elementId: element.id,
                  }).catch((error: Error) =>
                    toast.error('Failed to restore element', {
                      description: errorMessage(error),
                    })
                  ),
              },
            });
          },
          onError: (error) =>
            toast.error('Failed to remove element', {
              description: errorMessage(error),
            }),
        }
      );
    },
    [deleteElement, isPersisted, sequenceId, queryClient]
  );

  const removeDraftElement = useCallback(
    (tempPath: string) => {
      emitDraftElements(
        draftElementsRef.current.filter((el) => el.tempPath !== tempPath)
      );
    },
    [emitDraftElements]
  );

  // Rename a draft (pre-sequence) element in the parent's canonical list; the
  // parent rewrites script references through onDraftTokenRename. Uniqueness
  // is checked locally — promoteTempElements would silently suffix a
  // collision, but a user-typed name should be rejected loudly instead
  // (matching the persisted rename server fn).
  const renameDraftElement = useCallback(
    // oxlint-disable-next-line require-await -- ElementTokenButton takes an async commit; rejections surface inline
    async (tempPath: string, nextToken: string) => {
      const current = draftElementsRef.current;
      const target = current.find((el) => el.tempPath === tempPath);
      if (!target || nextToken === target.token) return;
      const duplicate = current.some(
        (el) => el.tempPath !== tempPath && el.token === nextToken
      );
      if (duplicate) {
        throw new Error(
          `Another element is already named "${nextToken}". Pick a different name.`
        );
      }
      emitDraftElements(
        current.map((el) =>
          el.tempPath === tempPath ? { ...el, token: nextToken } : el
        )
      );
      onDraftTokenRename?.(target.token, nextToken);
    },
    [emitDraftElements, onDraftTokenRename]
  );

  // Rename a persisted element — the server fn cascades the new token through
  // the sequence script and every shot that references it.
  const renamePersistedElement = useCallback(
    async (element: SequenceElement, nextToken: string) => {
      if (!isPersisted) return;
      const result = await renameToken.mutateAsync({
        sequenceId,
        elementId: element.id,
        token: nextToken,
      });
      const updates: string[] = [];
      if (result.scriptUpdated) updates.push('script');
      if (result.shotsUpdated > 0) {
        updates.push(
          `${result.shotsUpdated} shot${result.shotsUpdated === 1 ? '' : 's'}`
        );
      }
      const suffix =
        updates.length > 0 ? ` — updated ${updates.join(' + ')}` : '';
      toast.success(`Renamed to ${nextToken}${suffix}`);
    },
    [isPersisted, renameToken, sequenceId]
  );

  useImperativeHandle(
    ref,
    () => ({
      addFiles: (files) => void processFiles(files),
      open: () => setOpen(true),
    }),
    [processFiles]
  );

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      void processFiles(files);
      event.target.value = '';
    },
    [processFiles]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);
      const snapshot = snapshotDataTransfer(event.dataTransfer);
      void extractImagesFromSnapshot(snapshot).then(({ files, failedUrls }) => {
        if (files.length > 0) {
          void processFiles(files);
        } else if (failedUrls.length > 0) {
          toastDragImportCorsError();
        }
      });
    },
    [processFiles]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const items = event.clipboardData.items;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [processFiles]
  );

  // Build the display list: canonical elements first (persisted rows or the
  // parent's draft list), then transient local entries (in-flight / errored).
  const displayItems: Array<
    | { kind: 'persisted'; item: DisplayItem; source: SequenceElement }
    | { kind: 'draft'; item: DisplayItem; source: DraftElementUpload }
    | { kind: 'local'; item: DisplayItem; key: string }
  > = [];

  if (!isPersisted) {
    for (const el of draftElements ?? []) {
      displayItems.push({
        kind: 'draft',
        source: el,
        item: {
          key: `draft-${el.tempPath}`,
          imageUrl: el.tempPublicUrl,
          token: el.token,
          status: 'done',
        },
      });
    }
  }

  if (isPersisted) {
    for (const el of persistedElements) {
      const status: DisplayItem['status'] =
        el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
          ? 'analyzing'
          : el.visionStatus === 'failed'
            ? 'error'
            : 'done';
      displayItems.push({
        kind: 'persisted',
        source: el,
        item: {
          key: `persisted-${el.id}`,
          imageUrl: el.imageUrl,
          token: el.token,
          status,
          errorMessage: el.visionError ?? undefined,
        },
      });
    }
  }

  for (const [key, entry] of entries) {
    displayItems.push({
      kind: 'local',
      key,
      item: {
        key: `local-${key}`,
        imageUrl: entry.previewUrl,
        status: entry.status,
        errorMessage: entry.errorMessage,
      },
    });
  }

  const count = isPersisted
    ? persistedElements.length
    : (draftElements?.length ?? 0);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={handleInputChange}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="gap-1.5"
          >
            <ImagePlus className="size-3.5" />
            Elements
            {count > 0 && (
              <span className="ml-1 rounded-full bg-primary/10 px-1.5 text-xs">
                {count}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(420px,calc(100vw-2rem))]">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Upload reference elements</p>
              <p className="text-xs text-muted-foreground">
                Logos, product shots, screenshots. Type @ in a prompt or script
                to insert an element.
              </p>
            </div>
            {currentCount < MAX_SEQUENCE_ELEMENTS && (
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
                onDrop={handleDrop}
                onPaste={handlePaste}
                className={cn(
                  'relative flex select-none flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 min-h-[100px] outline-none transition-colors hover:bg-accent/30 focus-visible:border-ring/50 cursor-pointer',
                  dragOver && 'border-primary/50 bg-accent/30'
                )}
              >
                <Upload className="size-7 text-muted-foreground/50" />
                <span className="text-sm font-medium">
                  Drag & drop or paste
                </span>
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
                <span className="text-[11px] text-muted-foreground">
                  Up to {MAX_SEQUENCE_ELEMENTS} images
                </span>
              </div>
            )}
            {displayItems.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {displayItems.map((entry) => {
                  const { item } = entry;
                  return (
                    <div
                      key={item.key}
                      className="relative aspect-square overflow-hidden rounded-md group"
                    >
                      {/* biome-ignore lint/performance/noImgElement: preview uses object URL or R2 URL */}
                      <AppImage
                        src={item.imageUrl}
                        alt={item.token ?? 'Element'}
                        width={160}
                        height={160}
                        className="size-full object-cover"
                      />
                      {(item.status === 'uploading' ||
                        item.status === 'analyzing') && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/50">
                          <Loader2 className="size-5 animate-spin text-white" />
                          {item.status === 'analyzing' && (
                            <span className="text-[10px] font-medium text-white">
                              Analyzing…
                            </span>
                          )}
                        </div>
                      )}
                      {item.status === 'error' && (
                        <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 px-1 text-center text-[10px] font-medium text-white">
                          {item.errorMessage ?? 'Failed'}
                        </div>
                      )}
                      {item.status === 'done' &&
                        item.token &&
                        entry.kind !== 'local' && (
                          <ElementTokenButton
                            token={item.token}
                            onRename={(next) =>
                              entry.kind === 'persisted'
                                ? renamePersistedElement(entry.source, next)
                                : renameDraftElement(
                                    entry.source.tempPath,
                                    next
                                  )
                            }
                          />
                        )}
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        onClick={() => {
                          if (entry.kind === 'persisted') {
                            removePersistedElement(entry.source);
                          } else if (entry.kind === 'draft') {
                            removeDraftElement(entry.source.tempPath);
                          } else {
                            removeLocalEntry(entry.key);
                          }
                        }}
                        className="absolute top-1 right-1 size-5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
};
