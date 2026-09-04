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
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AppImage } from '@/components/ui/app-image';
import {
  useDeleteStudioAsset,
  useStudioPendingCreates,
  useToggleStudioFavorite,
} from '@/hooks/use-studio-assets';
import type { GeneratedAsset } from '@/lib/db/schema';
import {
  studioAspectRatio,
  studioPosterOutput,
  studioPrimaryOutput,
  studioPrompt,
} from '@/lib/studio/outputs';
import { estimateStudioProgress } from '@/lib/studio/progress';
import { cn } from '@/lib/utils';
import { Download, Images, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

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

function StudioCard({
  asset,
  onOpen,
}: {
  asset: GeneratedAsset;
  onOpen: () => void;
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
          <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
            {asset.error ?? 'Generation failed'}
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
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
      </div>
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

/** The opened asset at viewer size: the media fills the dialog, letterboxed. */
function StudioViewer({ asset }: { asset: GeneratedAsset }) {
  const primary = studioPrimaryOutput(asset);
  const poster = studioPosterOutput(asset);
  const prompt = studioPrompt(asset);
  if (asset.status === 'failed') {
    return (
      <p className="flex min-h-0 flex-1 items-center justify-center text-sm text-destructive">
        {asset.error ?? 'Generation failed'}
      </p>
    );
  }
  if (!primary) {
    return <Skeleton className="min-h-0 flex-1 rounded-lg" />;
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {primary.contentType.startsWith('video/') ? (
        <video
          src={primary.url}
          poster={poster?.url}
          controls
          autoPlay
          loop
          playsInline
          className="max-h-full max-w-full object-contain"
        >
          <track kind="captions" />
        </video>
      ) : (
        <img
          src={primary.url}
          alt={prompt || 'Generated image'}
          className="max-h-full max-w-full object-contain"
        />
      )}
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
}: {
  assets: GeneratedAsset[];
  isLoading: boolean;
  isAuthenticated: boolean;
  activity: 'image' | 'video';
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const remove = useDeleteStudioAsset();
  const openAsset = assets.find((asset) => asset.id === openId);
  const pending = useStudioPendingCreates(activity).flatMap((input, index) =>
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
        title={isAuthenticated ? 'Nothing here yet' : 'Sign in to generate'}
        description={
          isAuthenticated
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
            <StudioCard asset={asset} onOpen={() => setOpenId(asset.id)} />
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
          if (!open) setOpenId(null);
        }}
      >
        <DialogContent className="flex h-[94vh] w-[96vw] max-w-none flex-col gap-3 p-4 sm:max-w-none">
          {openAsset && (
            <>
              <DialogHeader className="shrink-0">
                <DialogTitle className="line-clamp-2 pr-8 text-base">
                  {studioPrompt(openAsset) || 'Generated asset'}
                </DialogTitle>
                <DialogDescription>
                  {openAsset.modelName} · {studioAspectRatio(openAsset)}
                </DialogDescription>
              </DialogHeader>
              <StudioViewer asset={openAsset} />
              <div className="flex shrink-0 items-center justify-end gap-2">
                {(() => {
                  const primary = studioPrimaryOutput(openAsset);
                  if (!primary) return null;
                  const ext = primary.contentType.split('/')[1] ?? 'bin';
                  return (
                    <Button asChild variant="outline">
                      <a
                        href={primary.url}
                        download={`openstory-${openAsset.id}.${ext}`}
                      >
                        <Download aria-hidden="true" />
                        Download
                      </a>
                    </Button>
                  );
                })()}
                {openAsset.status !== 'queued' &&
                  openAsset.status !== 'running' && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={remove.isPending}
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete this generation?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            It is removed from your library for good.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => {
                              remove.mutate(openAsset.id, {
                                onSuccess: () => setOpenId(null),
                              });
                            }}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
