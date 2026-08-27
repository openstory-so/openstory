import { BlobLoader } from '@/components/ui/blob-loader';
import {
  CONTENT_REJECTION_USER_HINT,
  CONTENT_REJECTION_USER_TITLE,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { cn } from '@/lib/utils';
import { AlertCircle, Info, Loader2 } from 'lucide-react';

type ShotStatus = 'pending' | 'generating' | 'completed' | 'failed' | null;

type VideoStateOverlayProps = {
  thumbnailUrl?: string | null;
  videoStatus: ShotStatus;
  /** Still-image lifecycle — a content-blocked still is a warning, not a crash. */
  imageStatus?: ShotStatus;
  imageError?: string | null;
  videoError?: string | null;
  className?: string;
  progressMessage?: React.ReactNode;
  /**
   * In-flight retry state (#882). When set, the overlay reads "Retrying
   * (attempt/maxAttempts)…" (or a bare "Retrying…" when the budget has no fixed
   * denominator) so a silently-retrying generation is distinguishable from a
   * hung one — both before the thumbnail exists (image retry, full loader) and
   * after (video retry, a non-blocking badge).
   */
  retry?: { attempt: number; maxAttempts?: number };
};

export const VideoStateOverlay: React.FC<VideoStateOverlayProps> = ({
  thumbnailUrl,
  videoStatus,
  imageStatus,
  imageError,
  videoError,
  className,
  progressMessage,
  retry,
}) => {
  // Only show loader when there's no thumbnail image yet
  const hasNoThumbnail = !thumbnailUrl;
  const imageFailed = imageStatus === 'failed';
  const videoFailed = videoStatus === 'failed';
  const hasFailed = videoFailed || (imageFailed && hasNoThumbnail);
  const contentBlocked =
    (imageFailed && isContentRejectionError(imageError)) ||
    (videoFailed && isContentRejectionError(videoError));
  const retryMessage = retry
    ? retry.maxAttempts
      ? `Retrying (${retry.attempt}/${retry.maxAttempts})…`
      : 'Retrying…'
    : undefined;

  // With a thumbnail and no failure the still image carries the UI — surface
  // something only while retrying, as a small badge that doesn't cover the
  // video's play button.
  if (!hasNoThumbnail && !hasFailed) {
    if (!retryMessage) return null;
    return (
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-2',
          className
        )}
      >
        <span className="flex items-center gap-1.5 rounded-full bg-background/80 px-3 py-1 text-xs font-medium backdrop-blur-sm">
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          {retryMessage}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        // pointer-events-none: the failed overlay is informational. Clicks
        // must reach the start-frame share control (and the still itself).
        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center',
        className
      )}
      style={{
        background: hasFailed
          ? 'rgba(0, 0, 0, 0.5)'
          : 'radial-gradient(circle at 50% 50%, rgba(167, 112, 239, 0.12), transparent 70%), hsl(var(--muted))',
      }}
    >
      <div className="flex flex-col items-center gap-4">
        {hasNoThumbnail && !hasFailed && (
          <>
            <BlobLoader size="lg" />
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <p className="text-sm font-medium">
                {retryMessage ?? progressMessage ?? 'Generating shot…'}
              </p>
            </div>
          </>
        )}

        {hasFailed &&
          (contentBlocked ? (
            <>
              <Info className="h-8 w-8 text-muted-foreground" />
              <p className="max-w-xs text-center text-sm font-medium">
                {CONTENT_REJECTION_USER_TITLE}
              </p>
              <p className="max-w-xs text-center text-xs text-muted-foreground">
                {CONTENT_REJECTION_USER_HINT}
              </p>
            </>
          ) : (
            <>
              <AlertCircle className="h-8 w-8 text-destructive" />
              <p className="text-sm font-medium text-destructive">
                Generation failed
              </p>
            </>
          ))}
      </div>
    </div>
  );
};
