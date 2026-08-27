import { BlobLoaderContainer } from '@/components/ui/blob-loader';
import {
  CONTENT_REJECTION_USER_TITLE,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import {
  type AspectRatio,
  getAspectRatioClassName,
} from '@/lib/constants/aspect-ratios';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AlertCircle, Info } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';
import { memo } from 'react';
import { hasUpscaleOverlay, UpscaleOverlay } from './upscale-overlay';

type SceneThumbnailProps = {
  thumbnailUrl?: string | null;
  previewThumbnailUrl?: string | null;
  thumbnailStatus?: 'pending' | 'generating' | 'completed' | 'failed';
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
};

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
}) => {
  // Display the final image if available, otherwise the preview
  const displayUrl = thumbnailUrl ?? previewThumbnailUrl;
  const isPreview = !thumbnailUrl && !!previewThumbnailUrl;
  const showOverlay = hasUpscaleOverlay({
    gridUrl: gridSheetUrl,
    variantIndex: pendingUpscaleIndex,
    cropUrl: pendingUpscaleUrl,
  });

  // Only show loader when there's no image at all
  const showLoader =
    !displayUrl &&
    !showOverlay &&
    !!thumbnailStatus &&
    thumbnailStatus !== 'failed';

  const showSkeleton = !displayUrl && !showOverlay && !thumbnailStatus;
  const isFailed = thumbnailStatus === 'failed' && !displayUrl && !showOverlay;

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

      {isPreview && (
        <span className="absolute top-1 right-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
          Storyboard
        </span>
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

const areEqual = (
  prevProps: SceneThumbnailProps,
  nextProps: SceneThumbnailProps
): boolean => {
  return (
    prevProps.thumbnailUrl === nextProps.thumbnailUrl &&
    prevProps.previewThumbnailUrl === nextProps.previewThumbnailUrl &&
    prevProps.thumbnailStatus === nextProps.thumbnailStatus &&
    prevProps.generationError === nextProps.generationError &&
    prevProps.alt === nextProps.alt &&
    prevProps.aspectRatio === nextProps.aspectRatio &&
    prevProps.className === nextProps.className &&
    prevProps.gridSheetUrl === nextProps.gridSheetUrl &&
    prevProps.pendingUpscaleIndex === nextProps.pendingUpscaleIndex &&
    prevProps.pendingUpscaleUrl === nextProps.pendingUpscaleUrl
  );
};

export const SceneThumbnail = memo(SceneThumbnailComponent, areEqual);
