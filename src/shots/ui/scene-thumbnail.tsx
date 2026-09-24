import { BlobLoaderContainer } from '@/ui/shadcn/blob-loader';
import {
  CONTENT_REJECTION_USER_TITLE,
  isContentRejectionError,
} from '@/models/content-rejection';
import {
  type AspectRatio,
  getAspectRatioClassName,
} from '@/models/aspect-ratios';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { cn } from '@/ui/utils';
import { AlertCircle, Info } from 'lucide-react';
import { AppImage } from '@/ui/shadcn/app-image';
import { memo } from 'react';
import { hasUpscaleOverlay, UpscaleOverlay } from './upscale-overlay';
import { videoPosterSrc } from '@/shots/packed-clip-window';

type SceneThumbnailProps = {
  thumbnailUrl?: string | null;
  previewThumbnailUrl?: string | null;
  thumbnailStatus?: 'pending' | 'generating' | 'completed' | 'failed';
  /**
   * Rendered clip for this shot. When there is no still — reference-only never
   * generates one — the only image left is the decorative storyboard preview,
   * which shows a composition the clip does not have. The clip's own first
   * frame is the truth once it exists, so it wins here. A still, where one
   * exists, IS the clip's first frame, so this changes nothing on that path.
   */
  videoUrl?: string | null;
  /**
   * In-point (seconds) inside a packed multi-shot clip (#1510). Later
   * members pin the poster to their window instead of the shared first
   * frame. Ignored when `videoUrl` is unset.
   */
  videoStartSeconds?: number;
  /** Provider error for a failed still — content flags render as a warning. */
  generationError?: string | null;
  alt: string;
  aspectRatio: AspectRatio;
  className?: string;
  /** Grid sheet URL used to CSS-crop `pendingUpscaleIndex`. */
  gridSheetUrl?: string | null;
  pendingUpscaleIndex?: number | null;
  /** Cropped tile URL persisted on the generating framing version (survives refresh). */
  pendingUpscaleUrl?: string | null;
  /** The shot's selected clip is an Ark draft (#1756): "Draft", "Draft · 2 days left", "Draft expired". */
  draftLabel?: string | null;
};

/**
 * What this tile shows, in precedence order. Extracted because the order is
 * the actual decision and it is easy to get subtly wrong:
 *
 *  1. an in-flight upscale overlay, which owns the whole tile
 *  2. the still — where one exists it IS the clip's first frame
 *  3. the clip's first frame — the truth for a shot that never had a still
 *  4. the storyboard preview — a placeholder for a still still coming
 *  5. loader / skeleton / failed
 *
 * 3 above 4 is the point: reference-only renders no still, so the preview is
 * a composition the finished clip does not have.
 */
export function chooseThumbnailSource(input: {
  thumbnailUrl?: string | null;
  previewThumbnailUrl?: string | null;
  videoUrl?: string | null;
  hasUpscaleOverlay: boolean;
  thumbnailStatus?: 'pending' | 'generating' | 'completed' | 'failed';
}): 'overlay' | 'image' | 'video' | 'loader' | 'skeleton' | 'failed' {
  if (input.hasUpscaleOverlay) return 'overlay';
  if (input.thumbnailUrl) return 'image';
  if (input.videoUrl) return 'video';
  if (input.previewThumbnailUrl) return 'image';
  if (input.thumbnailStatus === 'failed') return 'failed';
  return input.thumbnailStatus ? 'loader' : 'skeleton';
}

const SceneThumbnailComponent: React.FC<SceneThumbnailProps> = ({
  thumbnailUrl,
  previewThumbnailUrl,
  thumbnailStatus,
  generationError,
  alt,
  aspectRatio,
  className,
  gridSheetUrl,
  pendingUpscaleIndex,
  pendingUpscaleUrl,
  videoUrl,
  videoStartSeconds = 0,
  draftLabel = null,
}) => {
  const showOverlay = hasUpscaleOverlay({
    gridUrl: gridSheetUrl,
    variantIndex: pendingUpscaleIndex,
    cropUrl: pendingUpscaleUrl,
  });
  const source = chooseThumbnailSource({
    thumbnailUrl,
    previewThumbnailUrl,
    videoUrl,
    hasUpscaleOverlay: showOverlay,
    thumbnailStatus,
  });

  const displayUrl =
    source === 'image' ? (thumbnailUrl ?? previewThumbnailUrl) : null;
  const isPreview = source === 'image' && !thumbnailUrl;
  const showVideoFrame = source === 'video';
  const showLoader = source === 'loader';
  const showSkeleton = source === 'skeleton';
  const isFailed = source === 'failed';

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        getAspectRatioClassName(aspectRatio),
        className
      )}
    >
      {showSkeleton && (
        <Skeleton className="absolute h-full w-full rounded-md" />
      )}
      {showLoader && (
        <BlobLoaderContainer size="sm" className="absolute inset-0" />
      )}

      {showVideoFrame &&
        !showOverlay && (
          // `#t=` pins the poster to this shot's window in a packed clip
          // (t=0.001 for the first member); `preload="metadata"` keeps it to
          // headers plus that frame rather than the whole clip.
          // Muted + playsInline + no controls: this is a thumbnail, not a player.
          <video
            src={videoPosterSrc(videoUrl ?? '', videoStartSeconds)}
            className="h-full w-full object-cover"
            preload="metadata"
            muted
            playsInline
            aria-label={alt}
          />
        )}

      {displayUrl && !showOverlay && (
        <AppImage
          src={displayUrl}
          alt={alt}
          className="h-full w-full object-cover"
          width={320}
          height={180}
        />
      )}

      <UpscaleOverlay
        aspectRatio={aspectRatio}
        gridUrl={gridSheetUrl}
        variantIndex={pendingUpscaleIndex}
        cropUrl={pendingUpscaleUrl}
        showLabel
      />

      {(isPreview || draftLabel) && (
        <div className="pointer-events-none absolute top-1 right-1 flex flex-col items-end gap-0.5">
          {isPreview && (
            <span className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
              Storyboard
            </span>
          )}
          {draftLabel && (
            <span className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
              {draftLabel}
            </span>
          )}
        </div>
      )}

      {isFailed && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <div className="flex flex-col items-center gap-2 px-2 text-center text-muted-foreground">
            {isContentRejectionError(generationError) ? (
              <>
                <Info className="h-6 w-6" />
                <span className="text-xs">{CONTENT_REJECTION_USER_TITLE}</span>
              </>
            ) : (
              <>
                <AlertCircle className="h-6 w-6" />
                <span className="text-xs">Failed to generate</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Default shallow compare, no hand-written comparator. Every prop here is a
// primitive, so the two are behaviourally identical — except an allowlist has
// to be updated for each new prop, and twice now it was not: #1272 added
// `generationError` after the fact, and `videoUrl` was missed entirely, which
// froze the tile on the previous clip's first frame because every listed prop
// was unchanged.
export const SceneThumbnail = memo(SceneThumbnailComponent);
