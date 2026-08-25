import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AppImage } from '@/components/ui/app-image';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useCancelPendingArtifact,
  useRestoreMusicPromptVariant,
  useRestoreShotPromptVariant,
  useSequenceMusicPromptVariants,
  useShotPromptVariants,
} from '@/hooks/use-prompt-variants';
import {
  useSelectFrameImageVersion,
  useSelectSegmentVideoVersion,
  useShotImageVersions,
  useShotVideoVersions,
} from '@/hooks/use-shots';
import {
  IMAGE_MODELS,
  isValidTextToImageModel,
  videoModelDisplayName,
} from '@/lib/ai/models';
import type { PromptVariantSource, PromptVersionStatus } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  Check,
  Image as ImageIcon,
  Loader2,
  Video,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PromptDiffView } from './prompt-diff-view';

type PromptHistoryMode = 'visual' | 'motion' | 'music';

type SharedProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ShotProps = SharedProps & {
  mode: 'visual' | 'motion';
  sequenceId: string;
  shotId: string;
  /** Current cached prompt — diff target. */
  currentText: string;
};

type MusicProps = SharedProps & {
  mode: 'music';
  sequenceId: string;
  /** Current cached music prompt — diff target. */
  currentText: string;
};

export type PromptHistorySheetProps = ShotProps | MusicProps;

const SOURCE_LABEL: Record<PromptVariantSource, string> = {
  'ai-generated': 'AI',
  'user-edit': 'You',
  regenerated: 'Regenerated',
  restored: 'Restored',
  softened: 'Softened',
};

const SOURCE_VARIANT: Record<
  PromptVariantSource,
  'default' | 'secondary' | 'outline'
> = {
  'ai-generated': 'secondary',
  'user-edit': 'default',
  regenerated: 'outline',
  restored: 'outline',
  softened: 'outline',
};

const TITLE: Record<PromptHistoryMode, string> = {
  visual: 'Visual history',
  motion: 'Motion history',
  music: 'Music prompt history',
};

type PromptRow = {
  id: string;
  source: PromptVariantSource;
  text: string;
  createdAt: Date;
  createdByName: string | null;
  inputHash: string | null;
  /** Lifecycle (#1085): non-'completed' rows are in-flight placeholders or
   * their terminal failures — greyed, no diff/restore, cancellable while
   * live. Music history predates the column and always reads 'completed'. */
  status: PromptVersionStatus;
};

const isLiveStatus = (status: string): boolean =>
  status === 'pending' || status === 'generating';

type MediaRow = {
  id: string;
  model: string;
  status: string;
  url: string | null;
  createdAt: Date;
  selected: boolean;
  kind?: 'model' | 'framing';
};

function formatTimestamp(d: Date): string {
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function imageModelDisplayName(model: string): string {
  return isValidTextToImageModel(model) ? IMAGE_MODELS[model].name : model;
}

/** True when a media URL is likely a still (not an mp4/webm). */
function isLikelyImageUrl(url: string): boolean {
  const path = url.split('?')[0]?.toLowerCase() ?? '';
  return (
    path.endsWith('.jpg') ||
    path.endsWith('.jpeg') ||
    path.endsWith('.png') ||
    path.endsWith('.webp') ||
    path.endsWith('.gif') ||
    path.endsWith('.avif')
  );
}

function asError(value: unknown): Error | null {
  if (value == null) return null;
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error('Unknown error');
}

function MediaStatusIcon({ status }: { status: string }) {
  if (status === 'completed')
    return <Check className="h-3 w-3 text-muted-foreground" aria-hidden />;
  if (status === 'failed')
    return <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden />;
  if (status === 'cancelled')
    return <Ban className="h-3 w-3 text-muted-foreground" aria-hidden />;
  return (
    <Loader2
      className="h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none"
      aria-hidden
    />
  );
}

type MediaHistoryListProps = {
  kind: 'image' | 'video';
  rows: MediaRow[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  selecting: boolean;
  onSelect: (versionId: string) => void;
  /** Cancel an in-flight generation (#1085) — image versions only today. */
  cancelling?: boolean;
  onCancel?: (versionId: string) => void;
};

/**
 * Image / video version list inside the history sheet (#1070). Clicking a row
 * expands a preview; "Use this version" commits the selection pointer.
 */
const MediaHistoryList: React.FC<MediaHistoryListProps> = ({
  kind,
  rows,
  isLoading,
  error,
  onRetry,
  selecting,
  onSelect,
  cancelling = false,
  onCancel,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const emptyLabel =
    kind === 'image'
      ? 'No image history yet — generate an image to start a record.'
      : 'No video history yet — generate a video to start a record.';

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 pt-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="mt-2">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Couldn't load history</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>{error.message}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            className="self-start"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!rows || rows.length === 0) {
    return <p className="pt-4 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ul className="flex flex-col gap-2 pt-2">
      {rows.map((row) => {
        const expanded = expandedId === row.id;
        const panelId = `${kind}-history-panel-${row.id}`;
        const triggerId = `${kind}-history-trigger-${row.id}`;
        const thumb = row.url;
        const modelLabel =
          kind === 'image'
            ? imageModelDisplayName(row.model)
            : videoModelDisplayName(row.model);
        const selectable =
          row.status === 'completed' && !!row.url && !row.selected;

        return (
          <li
            key={row.id}
            className={cn(
              'flex flex-col gap-2 rounded-md border p-3 transition-colors',
              row.selected && 'border-primary/40 bg-primary/5'
            )}
          >
            <button
              id={triggerId}
              type="button"
              onClick={() => setExpandedId(expanded ? null : row.id)}
              aria-expanded={expanded}
              aria-controls={panelId}
              className={cn(
                'flex w-full gap-3 rounded-sm text-left transition-colors',
                'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
              )}
            >
              <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md bg-muted">
                {thumb && row.status === 'completed' ? (
                  kind === 'video' ? (
                    // Video files can't go through Cloudflare Image Transforms;
                    // preload=metadata is enough for a first-frame strip thumb.
                    // Prefer an image poster when the row carries one.
                    isLikelyImageUrl(thumb) ? (
                      <AppImage
                        src={thumb}
                        alt=""
                        width={96}
                        height={64}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      // eslint-disable-next-line jsx-a11y/media-has-caption -- Generated asset preview; no caption track exists.
                      <video
                        src={thumb}
                        muted
                        playsInline
                        preload="metadata"
                        className="h-full w-full object-cover"
                        aria-hidden
                      />
                    )
                  ) : (
                    <AppImage
                      src={thumb}
                      alt=""
                      width={96}
                      height={64}
                      className="h-full w-full object-cover"
                    />
                  )
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    {kind === 'video' ? (
                      <Video className="h-5 w-5" aria-hidden />
                    ) : (
                      <ImageIcon className="h-5 w-5" aria-hidden />
                    )}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <MediaStatusIcon status={row.status} />
                    <span className="truncate text-sm font-medium">
                      {modelLabel}
                    </span>
                    {row.selected && <Badge variant="outline">Current</Badge>}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatTimestamp(row.createdAt)}
                  </span>
                </div>
                {row.status === 'failed' && (
                  <span className="text-xs text-destructive">Failed</span>
                )}
                {row.status === 'cancelled' && (
                  <span className="text-xs text-muted-foreground">
                    Cancelled
                  </span>
                )}
                {isLiveStatus(row.status) && (
                  <span className="text-xs text-muted-foreground">
                    Generating…
                  </span>
                )}
              </div>
            </button>

            {onCancel && isLiveStatus(row.status) && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={cancelling}
                  onClick={() => onCancel(row.id)}
                  aria-label={`Cancel this ${kind} generation`}
                >
                  {cancelling && (
                    <Loader2 className="mr-2 h-3 w-3 animate-spin motion-reduce:animate-none" />
                  )}
                  <span>Cancel</span>
                </Button>
              </div>
            )}

            {expanded && (
              <section
                id={panelId}
                aria-labelledby={triggerId}
                className="flex flex-col gap-2"
              >
                {row.url && row.status === 'completed' ? (
                  kind === 'video' ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption -- Generated asset preview; no caption track exists.
                    <video
                      src={row.url}
                      controls
                      playsInline
                      className="max-h-64 w-full rounded-md bg-black object-contain"
                      aria-label={`${modelLabel} preview`}
                    />
                  ) : (
                    <AppImage
                      src={row.url}
                      alt={`${modelLabel} preview`}
                      width={640}
                      height={360}
                      className="max-h-64 w-full rounded-md object-contain"
                    />
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {row.status === 'generating'
                      ? 'Still generating — preview will appear when it finishes.'
                      : row.status === 'failed'
                        ? 'This generation failed — no preview available.'
                        : 'No preview available.'}
                  </p>
                )}
                {selectable && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      disabled={selecting}
                      onClick={() => onSelect(row.id)}
                    >
                      {selecting && (
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                      )}
                      <span>Use this version</span>
                    </Button>
                  </div>
                )}
              </section>
            )}
          </li>
        );
      })}
    </ul>
  );
};

type PromptHistoryListProps = {
  rows: PromptRow[] | undefined;
  currentText: string;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  restorePending: boolean;
  onRestore: (variantId: string) => void;
  /** Cancel an in-flight prompt generation (#1085). */
  cancelling?: boolean;
  onCancel?: (variantId: string) => void;
};

const PromptHistoryList: React.FC<PromptHistoryListProps> = ({
  rows,
  currentText,
  isLoading,
  error,
  onRetry,
  restorePending,
  onRestore,
  cancelling = false,
  onCancel,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 pt-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="mt-2">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Couldn't load history</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>{error.message}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            className="self-start"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <p className="pt-4 text-sm text-muted-foreground">
        No history yet — generate or edit a prompt to start a record.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2 pt-2">
      {rows.map((row) => {
        // In-flight placeholders and their terminal failures (#1085): no
        // text to diff or restore — a quiet status row, cancellable while
        // the generation is still live.
        if (row.status !== 'completed') {
          const live = isLiveStatus(row.status);
          return (
            <li
              key={row.id}
              className="flex flex-col gap-2 rounded-md border border-dashed p-3 text-muted-foreground"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {live ? (
                    <Loader2
                      className="h-3 w-3 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : row.status === 'failed' ? (
                    <AlertTriangle
                      className="h-3 w-3 text-destructive"
                      aria-hidden
                    />
                  ) : (
                    <Ban className="h-3 w-3" aria-hidden />
                  )}
                  <span className="text-sm">
                    {live
                      ? 'Generating…'
                      : row.status === 'failed'
                        ? 'Generation failed'
                        : 'Cancelled'}
                  </span>
                </div>
                <span className="text-xs tabular-nums">
                  {formatTimestamp(row.createdAt)}
                </span>
              </div>
              {live && onCancel && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={cancelling}
                    onClick={() => onCancel(row.id)}
                    aria-label="Cancel this prompt generation"
                  >
                    {cancelling && (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin motion-reduce:animate-none" />
                    )}
                    <span>Cancel</span>
                  </Button>
                </div>
              )}
            </li>
          );
        }

        const expanded = expandedId === row.id;
        const isCurrent = row.text === currentText;
        const panelId = `prompt-history-panel-${row.id}`;
        const triggerId = `prompt-history-trigger-${row.id}`;
        return (
          <li
            key={row.id}
            className={cn(
              'flex flex-col gap-2 rounded-md border p-3 transition-colors',
              isCurrent && 'border-primary/40 bg-primary/5'
            )}
          >
            <button
              id={triggerId}
              type="button"
              onClick={() => setExpandedId(expanded ? null : row.id)}
              aria-expanded={expanded}
              aria-controls={panelId}
              className={cn(
                'flex w-full flex-col gap-2 rounded-sm text-left transition-colors',
                'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={SOURCE_VARIANT[row.source]}>
                    {SOURCE_LABEL[row.source]}
                  </Badge>
                  {isCurrent && <Badge variant="outline">Current</Badge>}
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatTimestamp(row.createdAt)}
                </span>
              </div>
              {row.source === 'softened' && (
                <p className="text-xs text-muted-foreground">
                  Rewritten to pass a content checker. The original is still in
                  this list.
                </p>
              )}
              {row.createdByName && (
                <span className="text-xs text-muted-foreground">
                  by {row.createdByName}
                </span>
              )}
              {!expanded && (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {row.text}
                </p>
              )}
            </button>
            {expanded && (
              <section
                id={panelId}
                aria-labelledby={triggerId}
                className="flex flex-col gap-2"
              >
                <PromptDiffView before={currentText} after={row.text} />
                {!isCurrent && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      disabled={restorePending}
                      onClick={() => onRestore(row.id)}
                    >
                      {restorePending && (
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                      )}
                      <span>Restore this version</span>
                    </Button>
                  </div>
                )}
              </section>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export const PromptHistorySheet: React.FC<PromptHistorySheetProps> = (
  props
) => {
  const { open, onOpenChange, mode, currentText, sequenceId } = props;
  const shotId = props.mode === 'music' ? null : props.shotId;

  const isMusic = mode === 'music';
  // For the shot hooks when in music mode the value is unused (query disabled);
  // 'visual' is just a type-safe placeholder.
  const shotPromptType = isMusic ? 'visual' : mode;
  const mediaKind = mode === 'motion' ? 'video' : 'image';
  const defaultTab = 'prompt';

  const shotQuery = useShotPromptVariants(
    { sequenceId, shotId: shotId ?? '', promptType: shotPromptType },
    { enabled: open && !isMusic && !!shotId }
  );
  const musicQuery = useSequenceMusicPromptVariants(sequenceId, {
    enabled: open && isMusic,
  });

  const active = isMusic ? musicQuery : shotQuery;
  const { isLoading, error, refetch } = active;
  const promptRows: PromptRow[] | undefined = isMusic
    ? musicQuery.data?.map((v) => ({
        id: v.id,
        source: v.source,
        text: v.prompt,
        createdAt: v.createdAt,
        createdByName: v.createdByName,
        inputHash: v.inputHash,
        status: 'completed' as const,
      }))
    : shotQuery.data?.map((v) => ({
        id: v.id,
        source: v.source,
        text: v.text,
        createdAt: v.createdAt,
        createdByName: v.createdByName,
        inputHash: v.inputHash,
        status: v.status,
      }));

  const restoreShot = useRestoreShotPromptVariant({
    sequenceId,
    shotId: shotId ?? '',
    promptType: shotPromptType,
  });
  const restoreMusic = useRestoreMusicPromptVariant(sequenceId);
  const restoreMutation = isMusic ? restoreMusic : restoreShot;

  // Cancel an in-flight pending claim (#1085) — shot modes only.
  const cancelPending = useCancelPendingArtifact({
    sequenceId,
    shotId: shotId ?? '',
  });
  const onCancelPrompt = isMusic
    ? undefined
    : (versionId: string) =>
        cancelPending.mutate(
          {
            versionId,
            artifact: mode === 'visual' ? 'visual-prompt' : 'motion-prompt',
          },
          {
            onSuccess: ({ cancelled }) => {
              if (!cancelled) toast.info('This generation already finished');
            },
            onError: (err) =>
              toast.error('Cancel failed', {
                description:
                  err instanceof Error ? err.message : 'Unknown error',
              }),
          }
        );
  const onCancelImage =
    isMusic || mode !== 'visual'
      ? undefined
      : (versionId: string) =>
          cancelPending.mutate(
            { versionId, artifact: 'image' },
            {
              onSuccess: ({ cancelled }) => {
                if (!cancelled) toast.info('This generation already finished');
              },
              onError: (err) =>
                toast.error('Cancel failed', {
                  description:
                    err instanceof Error ? err.message : 'Unknown error',
                }),
            }
          );

  const imageQuery = useShotImageVersions(
    { sequenceId, shotId: shotId ?? '' },
    { enabled: open && mode === 'visual' && !!shotId }
  );
  const videoQuery = useShotVideoVersions(
    { sequenceId, shotId: shotId ?? '' },
    { enabled: open && mode === 'motion' && !!shotId }
  );
  const mediaQuery = mode === 'motion' ? videoQuery : imageQuery;

  const selectImage = useSelectFrameImageVersion();
  const selectVideo = useSelectSegmentVideoVersion();
  const selectMutation = mode === 'motion' ? selectVideo : selectImage;

  const onRestore = (variantId: string) =>
    restoreMutation.mutate(variantId, {
      onSuccess: () => toast.success('Prompt restored'),
      onError: (err) =>
        toast.error('Restore failed', {
          description: err instanceof Error ? err.message : 'Unknown error',
        }),
    });

  const onSelectMedia = (versionId: string) => {
    if (!shotId) return;
    selectMutation.mutate(
      { sequenceId, shotId, versionId },
      {
        onSuccess: () =>
          toast.success(
            mediaKind === 'image'
              ? 'Image selected — linked prompt restored when available'
              : 'Video version selected'
          ),
        onError: (err) =>
          toast.error(
            mediaKind === 'image'
              ? 'Failed to switch image version'
              : 'Failed to switch video version',
            {
              description: err instanceof Error ? err.message : 'Unknown error',
            }
          ),
      }
    );
  };

  const description = isMusic
    ? 'Append-only history. Restore writes a new entry without deleting anything.'
    : mode === 'visual'
      ? 'Prompt edits and generated images. Selecting an image restores the still and the prompt that produced it (when linked). A Softened version is an automatic rewrite to pass a content checker — the original stays here.'
      : 'Prompt edits and rendered videos. Selecting a video repoints playback without deleting anything.';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{TITLE[mode]}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        {isMusic ? (
          <ScrollArea className="flex-1 px-4 pb-4">
            <PromptHistoryList
              rows={promptRows}
              currentText={currentText}
              isLoading={isLoading}
              error={asError(error)}
              onRetry={() => void refetch()}
              restorePending={restoreMutation.isPending}
              onRestore={onRestore}
            />
          </ScrollArea>
        ) : (
          <Tabs
            defaultValue={defaultTab}
            className="flex min-h-0 flex-1 flex-col gap-0 px-4 pb-4"
          >
            <TabsList className="w-full">
              <TabsTrigger value="prompt" className="flex-1">
                Prompt
              </TabsTrigger>
              <TabsTrigger value="media" className="flex-1">
                {mode === 'visual' ? 'Images' : 'Videos'}
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="prompt"
              className="min-h-0 flex-1 overflow-hidden"
            >
              <ScrollArea className="h-full">
                <PromptHistoryList
                  rows={promptRows}
                  currentText={currentText}
                  isLoading={isLoading}
                  error={asError(error)}
                  onRetry={() => void refetch()}
                  restorePending={restoreMutation.isPending}
                  onRestore={onRestore}
                  cancelling={cancelPending.isPending}
                  onCancel={onCancelPrompt}
                />
              </ScrollArea>
            </TabsContent>
            <TabsContent
              value="media"
              className="min-h-0 flex-1 overflow-hidden"
            >
              <ScrollArea className="h-full">
                <MediaHistoryList
                  kind={mediaKind}
                  rows={mediaQuery.data}
                  isLoading={mediaQuery.isLoading}
                  error={asError(mediaQuery.error)}
                  onRetry={() => void mediaQuery.refetch()}
                  selecting={selectMutation.isPending}
                  onSelect={onSelectMedia}
                  cancelling={cancelPending.isPending}
                  onCancel={onCancelImage}
                />
              </ScrollArea>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
};
