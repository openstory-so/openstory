import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/shadcn/alert-dialog';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { AppImage } from '@/ui/shadcn/app-image';
import { ElementThumbnail } from '@/cast/ui/element/element-thumbnail';
import { HighlightedPrompt } from '@/ui/text-editor/mention/highlighted-prompt';
import type { MentionItem } from '@/shots/ui/prompt-mention/mention-items';
import {
  useDeleteStudioAsset,
  useStudioPendingCreates,
  useToggleStudioFavorite,
} from './use-studio-assets';
import type { GeneratedAsset } from '@/platform/server/db/schema';
import {
  studioAspectRatio,
  studioDownloadFilename,
  studioDownloadHref,
  studioPosterOutput,
  studioPrimaryOutput,
  studioPrompt,
  studioShareUrl,
} from './outputs';
import {
  readableStudioPrompt,
  studioGenerationFacts,
  studioReuse,
  studioShownReferences,
  type StudioReuse,
  type StudioShownReference,
} from './prompt-display';
import {
  CONTENT_REJECTION_USER_TITLE,
  isContentRejectionError,
} from '@/models/content-rejection';
import { estimateStudioProgress } from './progress';
import { copyTextToClipboard } from '@/ui/clipboard';
import { VideoPlayer } from '@/motion/ui/video-player';
import type { AspectRatio } from '@/models/aspect-ratios';
import { cn } from '@/ui/utils';
import { usePostHog } from '@posthog/react';
import {
  AudioLines,
  Copy,
  Download,
  Images,
  Link,
  RotateCcw,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Wall clock ticking once a second while `active`; null otherwise. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : null;
}

export type StudioGalleryAsset = GeneratedAsset & {
  creatorName?: string | null;
  creatorEmail?: string | null;
};

function StudioCard({
  asset,
  onOpen,
  supportMode,
}: {
  asset: StudioGalleryAsset;
  onOpen: () => void;
  supportMode: boolean;
}) {
  const favorite = useToggleStudioFavorite();
  const primary = studioPrimaryOutput(asset);
  const poster = studioPosterOutput(asset);
  const prompt = studioPrompt(asset);
  const inFlight = asset.status === 'queued' || asset.status === 'running';
  const isVideo = primary?.contentType.startsWith('video/');
  const now = useNow(inFlight);
  const progress =
    now === null
      ? null
      : estimateStudioProgress(
          asset.activity === 'video' ? 'video' : 'image',
          asset.createdAt,
          now
        );

  return (
    <article className="group relative overflow-hidden rounded-lg border bg-muted">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full overflow-hidden text-left"
        style={{ aspectRatio: studioAspectRatio(asset).replace(':', ' / ') }}
        aria-label={prompt || 'Generated asset'}
      >
        {inFlight ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : asset.status === 'failed' ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-destructive">
            {isContentRejectionError(asset.error)
              ? CONTENT_REJECTION_USER_TITLE
              : 'Generation failed'}
          </div>
        ) : isVideo && primary ? (
          <video
            src={primary.url}
            poster={poster?.url}
            muted
            playsInline
            loop
            className="h-full w-full object-cover"
            onMouseEnter={(event) => {
              if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
                return;
              void event.currentTarget.play();
            }}
            onMouseLeave={(event) => {
              event.currentTarget.pause();
              event.currentTarget.currentTime = 0;
            }}
          >
            <track kind="captions" />
          </video>
        ) : primary ? (
          <AppImage
            src={primary.url}
            alt={prompt || 'Generated image'}
            width={768}
            height={768}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No output
          </div>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-end gap-1 p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[data-state=open]]:opacity-100">
        {!supportMode && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="pointer-events-auto"
            aria-label={asset.isFavorite ? 'Remove from favorites' : 'Favorite'}
            aria-pressed={asset.isFavorite}
            onClick={() =>
              favorite.mutate({
                id: asset.id,
                isFavorite: !asset.isFavorite,
              })
            }
          >
            <Star
              className={cn(asset.isFavorite && 'fill-current')}
              aria-hidden="true"
            />
          </Button>
        )}
        <StudioShareMenu asset={asset} className="pointer-events-auto" />
      </div>
      {supportMode && (asset.creatorName || asset.creatorEmail) && (
        <p className="pointer-events-none absolute inset-x-0 top-0 truncate bg-background/80 px-2 py-1 text-xs text-muted-foreground">
          <span>
            {asset.creatorName && asset.creatorEmail
              ? `${asset.creatorName} · ${asset.creatorEmail}`
              : (asset.creatorName ?? asset.creatorEmail)}
          </span>
        </p>
      )}
      {inFlight && (
        <p
          aria-live="polite"
          className="absolute inset-x-0 bottom-0 bg-background/80 px-2 py-1 text-xs text-muted-foreground tabular-nums"
        >
          {asset.status === 'queued' ? 'Queued…' : 'Generating…'}
          <span>{` ${progress ?? 0}%`}</span>
        </p>
      )}
    </article>
  );
}

/** Stand-in for a generation whose rows have not landed in the list yet (#1455). */
function PendingCard({ aspectRatio }: { aspectRatio: string }) {
  return (
    <article className="relative overflow-hidden rounded-lg border bg-muted">
      <Skeleton
        className="w-full rounded-none"
        style={{ aspectRatio: aspectRatio.replace(':', ' / ') }}
      />
      <p
        aria-live="polite"
        className="absolute inset-x-0 bottom-0 bg-background/80 px-2 py-1 text-xs text-muted-foreground"
      >
        Starting…
      </p>
    </article>
  );
}

/**
 * Share and download pinned to the media. Share link copies the URL on click.
 */
function StudioShareMenu({
  asset,
  className,
}: {
  asset: GeneratedAsset;
  className?: string;
}) {
  const posthog = usePostHog();
  const primary = studioPrimaryOutput(asset);
  if (!primary || asset.status !== 'completed') return null;

  const video = primary.contentType.startsWith('video/');
  const surface = video ? 'studio_video' : 'studio_image';

  const copyLink = async () => {
    posthog.capture('share_clicked', {
      surface,
      asset_id: asset.id,
    });
    const shareable = studioShareUrl(primary.url, window.location.origin);
    if (!(await copyTextToClipboard(shareable))) {
      toast.error('Failed to copy URL');
      return;
    }
    toast.success('Copied');
  };

  const download = () => {
    posthog.capture('export_clicked', {
      surface,
      asset_id: asset.id,
    });
    const a = document.createElement('a');
    a.href = studioDownloadHref(primary.url);
    a.download = studioDownloadFilename(asset.id, primary.contentType);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className={cn('flex gap-1', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Download"
            onClick={download}
          >
            <Download aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Share link"
            onClick={() => void copyLink()}
          >
            <Link aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Share link</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * VideoPlayer derives its height from its width. Cap the width so that
 * height stays inside the dialog — the same fit the sample-video dialog
 * uses. Tighter on a phone, where the clip sits above the recipe.
 */
function studioPlayerWidth(aspect: AspectRatio): string {
  if (aspect === '9:16')
    return 'max-w-[min(100%,28vh)] md:max-w-[min(100%,42vh)]';
  if (aspect === '1:1')
    return 'max-w-[min(100%,46vh)] md:max-w-[min(100%,72vh)]';
  return 'max-w-[min(100%,82vh)] md:max-w-[min(100%,128vh)]';
}

/** The opened asset at viewer size: the media fills the dialog, letterboxed. */
function StudioViewer({ asset }: { asset: GeneratedAsset }) {
  const primary = studioPrimaryOutput(asset);
  const poster = studioPosterOutput(asset);
  const prompt = studioPrompt(asset);
  const aspect = studioAspectRatio(asset);
  if (asset.status === 'failed') {
    return (
      <p className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 text-center text-sm break-words text-destructive select-text">
        {asset.error ?? 'Generation failed'}
      </p>
    );
  }
  if (!primary) {
    return <Skeleton className="min-h-0 flex-1 rounded-lg" />;
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted">
      <div className="relative w-fit max-w-full">
        {primary.contentType.startsWith('video/') ? (
          <VideoPlayer
            src={primary.url}
            posterSrc={poster?.url}
            aspectRatio={aspect}
            autoPlay
            playSource="modal"
            className={cn(
              'overflow-hidden rounded-lg',
              studioPlayerWidth(aspect)
            )}
          />
        ) : (
          <img
            src={primary.url}
            alt={prompt || 'Generated image'}
            className="block max-h-full max-w-full object-contain"
          />
        )}
        <StudioShareMenu asset={asset} className="absolute top-2 left-2 z-30" />
      </div>
    </div>
  );
}

function mentionItems(references: StudioShownReference[]): MentionItem[] {
  return references.flatMap((reference) =>
    reference.tag
      ? [
          {
            id: reference.tag,
            section: 'references' as const,
            label: reference.label,
            tag: reference.tag,
            haystack: reference.tag.toLowerCase(),
          },
        ]
      : []
  );
}

function ReferenceTile({ reference }: { reference: StudioShownReference }) {
  return (
    <li className="w-16 shrink-0">
      <figure className="flex flex-col items-center gap-1">
        <div className="size-16 overflow-hidden rounded-md border bg-muted">
          {reference.kind === 'audio' ? (
            <div className="flex size-16 items-center justify-center">
              <AudioLines
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          ) : reference.kind === 'video' ? (
            <ElementThumbnail
              kind="video"
              url={reference.url}
              label={reference.label}
              fit="cover"
            />
          ) : (
            <AppImage
              src={reference.url}
              alt=""
              width={64}
              height={64}
              className="size-16 object-cover"
            />
          )}
        </div>
        <figcaption className="w-full truncate text-center font-mono text-xs text-muted-foreground">
          {reference.label}
        </figcaption>
      </figure>
    </li>
  );
}

/**
 * The clip fills the dialog. The recipe sits against it and only grows with
 * its content: model, settings, the prompt, then the references it names,
 * then the actions. A long prompt scrolls inside its own box.
 */
export function GenerationDetail({
  asset,
  supportMode,
  copied,
  onCopy,
  onReuse,
  deletePending,
  onDelete,
}: {
  asset: StudioGalleryAsset;
  supportMode: boolean;
  copied: boolean;
  onCopy: (prompt: string) => void;
  onReuse?: (reuse: StudioReuse) => void;
  deletePending: boolean;
  onDelete: () => void;
}) {
  const prompt = readableStudioPrompt(studioPrompt(asset));
  const references = studioShownReferences(asset);
  const reuse = studioReuse(asset);
  const creator = [asset.creatorName, asset.creatorEmail]
    .filter(Boolean)
    .join(' · ');
  const facts = [
    ...studioGenerationFacts(asset),
    supportMode ? creator : '',
  ].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted md:flex-row">
      <div className="flex min-h-48 min-w-0 flex-1 p-3 md:p-4">
        <StudioViewer asset={asset} />
      </div>
      <aside className="flex max-h-[40%] w-full shrink-0 flex-col gap-3 overflow-y-auto border-t bg-popover p-4 md:max-h-full md:w-96 md:self-start md:border-t-0 md:border-l md:pr-12">
        <DialogHeader>
          <DialogTitle>{asset.modelName || 'Generation'}</DialogTitle>
          <DialogDescription>{facts.join(' · ')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto">
          {prompt ? (
            <HighlightedPrompt
              text={prompt}
              items={mentionItems(references)}
              className="text-sm leading-relaxed break-words select-text"
            />
          ) : (
            <p className="text-sm text-muted-foreground">No prompt</p>
          )}
        </div>
        {references.length > 0 && (
          <ul className="flex gap-2 overflow-x-auto" aria-label="References">
            {references.map((reference) => (
              <ReferenceTile
                key={`${reference.label}-${reference.url}`}
                reference={reference}
              />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="pointer-coarse:h-11"
            disabled={!prompt}
            aria-label={copied ? 'Copied prompt' : 'Copy prompt'}
            onClick={() => onCopy(prompt)}
          >
            <Copy aria-hidden="true" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {onReuse && reuse && (
            <Button
              type="button"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => onReuse(reuse)}
            >
              <RotateCcw aria-hidden="true" />
              Use again
            </Button>
          )}
          {!supportMode &&
            asset.status !== 'queued' &&
            asset.status !== 'running' && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    className="pointer-coarse:size-11"
                    disabled={deletePending}
                    aria-label="Delete"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this generation?</AlertDialogTitle>
                    <AlertDialogDescription>
                      It is removed from your library for good.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction onClick={onDelete}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
        </div>
      </aside>
    </div>
  );
}

export function StudioGallery({
  assets,
  isLoading,
  isAuthenticated,
  activity,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  supportMode = false,
  onReuse,
}: {
  assets: StudioGalleryAsset[];
  isLoading: boolean;
  isAuthenticated: boolean;
  activity: 'image' | 'video';
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  supportMode?: boolean;
  /** Load this generation's prompt and references into the composer. */
  onReuse?: (reuse: StudioReuse) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const remove = useDeleteStudioAsset();
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  const openAsset = assets.find((asset) => asset.id === openId);
  const pendingCreates = useStudioPendingCreates(activity);
  const pending = supportMode
    ? []
    : pendingCreates.flatMap((input, index) =>
        Array.from({ length: input.count }, (_, i) => ({
          key: `pending-${index}-${i}`,
          aspectRatio: input.aspectRatio,
        }))
      );

  if (isLoading) {
    return (
      <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton
            key={index}
            className="mb-4 aspect-video w-full rounded-lg"
          />
        ))}
      </div>
    );
  }

  if (assets.length === 0 && pending.length === 0) {
    return (
      <EmptyState
        icon={<Images className="h-12 w-12" />}
        title={
          supportMode
            ? activity === 'video'
              ? 'No matching videos'
              : 'No matching images'
            : isAuthenticated
              ? 'Nothing here yet'
              : 'Sign in to generate'
        }
        description={
          supportMode
            ? activity === 'video'
              ? 'No clips match this search across any users.'
              : 'No stills match this search across any users.'
            : isAuthenticated
              ? activity === 'video'
                ? 'Your clips land here. Start with a prompt below.'
                : 'Your stills land here. Start with a prompt below.'
              : 'Browse the composer, then sign in to generate and keep a library.'
        }
      />
    );
  }

  return (
    <>
      <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
        {pending.map((tile) => (
          <div key={tile.key} className="mb-4 break-inside-avoid">
            <PendingCard aspectRatio={tile.aspectRatio} />
          </div>
        ))}
        {assets.map((asset) => (
          <div key={asset.id} className="mb-4 break-inside-avoid">
            <StudioCard
              asset={asset}
              onOpen={() => setOpenId(asset.id)}
              supportMode={supportMode}
            />
          </div>
        ))}
      </div>
      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <Dialog
        open={openAsset != null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenId(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent className="flex h-[94vh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          {openAsset && (
            <GenerationDetail
              asset={openAsset}
              supportMode={supportMode}
              copied={copied}
              onCopy={(prompt) => {
                void copyTextToClipboard(prompt).then((ok) => {
                  if (ok) setCopied(true);
                });
              }}
              onReuse={
                onReuse
                  ? (reuse) => {
                      setOpenId(null);
                      setCopied(false);
                      onReuse(reuse);
                    }
                  : undefined
              }
              deletePending={remove.isPending}
              onDelete={() => {
                remove.mutate(openAsset.id, {
                  onSuccess: () => setOpenId(null),
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
