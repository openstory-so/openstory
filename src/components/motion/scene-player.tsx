import { type TabValue } from '@/components/scenes/scene-script-prompts';
import { BlobLoader } from '@/components/ui/blob-loader';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import type { SceneWithScript } from '@/hooks/use-scenes';
import { useShotDownloadUrl } from '@/hooks/use-shot-download-url';
import {
  type AspectRatio,
  aspectRatioToDimensions,
  getAspectRatioClassName,
} from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/utils/clipboard';
import type { ShotView } from '@/lib/shots/shot-view';
import { AppImage } from '@/components/ui/app-image';
import { Download, Link, Loader2, Share2, VideoIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { VideoPlayer } from './video-player';
import { VideoStateOverlay } from './video-state-overlay';

type ScenePlayerProps = {
  shots?: ShotView[];
  /** Scenes the shots belong to — the source of the displayed scene's title. */
  scenes?: readonly SceneWithScript[];
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  /**
   * Accepted but unused: the player no longer auto-advances between scenes
   * (single-scene review shouldn't roll into the next clip — use Theatre for
   * continuous playback). Shot selection is driven by the scene list.
   */
  onSelectShot?: (shotId: string) => void;
  className?: string;
  wrapperClassName?: string;
  selectedTab?: TabValue;
  overrideImageUrl?: string | null;
  /**
   * Per-scene video-variant preview (#545). When set (motion tab), the player
   * plays this url for the current shot instead of its primary video — the
   * motion analog of `overrideImageUrl`.
   */
  overrideVideoUrl?: string | null;
  badgeMessage?: string | null;
  /**
   * Warning badge shown when the pinned image model has not generated this
   * scene (#547) — the displayed image is the primary fallback, not the
   * pinned model's output.
   */
  modelMismatchLabel?: string | null;
  /**
   * Quiet stale chip (#1077) — the displayed image was generated from
   * earlier inputs. Info-level: amber dot on a muted chip, no warning fill.
   */
  staleLabel?: string | null;
  progressMessage?: React.ReactNode;
  /**
   * In-flight retry state for the selected shot (#882) — rendered as
   * "Retrying (N/M)…" (or "Retrying…") in the player overlay.
   */
  retry?: { attempt: number; maxAttempts?: number };
  posterUrl?: string;
  /**
   * Extra node rendered absolutely inside the frame container (#986) — e.g. the
   * starting-frame variants control. Positioned by the overlay itself.
   */
  frameOverlay?: React.ReactNode;
  onTimeUpdate?: (currentTime: number) => void;
  onEnded?: () => void;
};

export const ScenePlayer: React.FC<ScenePlayerProps> = ({
  shots,
  scenes,
  className,
  wrapperClassName,
  selectedShotId,
  aspectRatio,
  selectedTab,
  overrideImageUrl,
  overrideVideoUrl,
  badgeMessage,
  modelMismatchLabel,
  staleLabel,
  progressMessage,
  retry,
  posterUrl,
  frameOverlay,
  onTimeUpdate,
  onEnded,
}) => {
  const [shouldAutoPlay, setShouldAutoPlay] = useState(false);

  const imageDimensions = aspectRatioToDimensions(aspectRatio);
  // Derive the current shot synchronously from selection — do NOT park the
  // index in useState+useEffect. That lagged one render behind selectedShotId,
  // so on the image tab (where the VideoPlayer key is a constant empty src)
  // the previous shot's still stayed on screen after switching shots (#1070).
  const currentShotIndex =
    shots?.findIndex((shot) => shot.id === selectedShotId) ?? -1;
  const currentShot =
    shots && currentShotIndex >= 0 ? shots[currentShotIndex] : undefined;
  const nextShot =
    shots && currentShotIndex >= 0 && currentShotIndex < shots.length - 1
      ? shots.find(
          (shot, index) =>
            shot.videoStatus === 'completed' &&
            shot.video?.url &&
            index > currentShotIndex
        )
      : undefined;

  const handleCopyImageUrl = useCallback(async () => {
    if (!currentShot?.image?.url) return;
    try {
      // Stored media URLs are origin-relative (#894) — absolutize against the
      // current origin so the copied link is usable when pasted elsewhere. The
      // worker's public /r2 route serves it (redirecting to the CDN in prod).
      const absoluteUrl = new URL(currentShot.image.url, window.location.origin)
        .href;
      if (!(await copyTextToClipboard(absoluteUrl))) {
        toast.error('Failed to copy URL');
        return;
      }
      toast.success('Start frame URL copied');
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [currentShot?.image?.url]);

  const handleCopyVideoUrl = useCallback(async () => {
    if (!currentShot?.video?.url) return;
    try {
      const absoluteUrl = new URL(currentShot.video.url, window.location.origin)
        .href;
      if (!(await copyTextToClipboard(absoluteUrl))) {
        toast.error('Failed to copy URL');
        return;
      }
      toast.success('Segment URL copied');
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [currentShot?.video?.url]);

  // Check video status
  const hasCompletedVideo =
    currentShot &&
    currentShot.videoStatus === 'completed' &&
    currentShot.video?.url;
  const hasFailedVideo = currentShot && currentShot.videoStatus === 'failed';

  // Fetch signed download URL with Content-Disposition header (forces browser download)
  const { data: downloadData } = useShotDownloadUrl(
    { shotId: currentShot?.id, sequenceId: currentShot?.sequenceId },
    !!hasCompletedVideo
  );

  const handleDownloadVideo = useCallback(() => {
    if (!downloadData?.downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadData.downloadUrl;
    a.download =
      downloadData.filename ||
      `scene-${currentShot?.id ?? 'unknown'}_openstory.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [downloadData, currentShot?.id]);

  // Handle video pause - disable autoplay when user manually pauses
  const handlePause = useCallback(() => {
    setShouldAutoPlay(false);
  }, []);

  // Video end: stop on the current scene. We intentionally do NOT auto-advance
  // to the next scene — single-scene review shouldn't roll into the next clip.
  // Continuous playback of the whole sequence lives in Theatre.
  const handleEnded = useCallback(() => {
    setShouldAutoPlay(false);
    onEnded?.();
  }, [onEnded]);

  // Show blob loader during generation, skeleton otherwise
  if (!shots || shots.length === 0) {
    if (progressMessage) {
      return (
        <div className={cn('flex w-full flex-col', wrapperClassName)}>
          <div
            className={cn(
              'relative flex w-full items-center justify-center overflow-hidden bg-muted',
              className,
              getAspectRatioClassName(aspectRatio)
            )}
          >
            {posterUrl ? (
              <>
                <AppImage
                  src={posterUrl}
                  alt=""
                  width={imageDimensions.width}
                  height={imageDimensions.height}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <span className="absolute top-2 right-2 z-10 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                  Preview
                </span>
                <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent p-4">
                  <p className="text-center text-sm font-medium text-white">
                    {progressMessage}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(167,112,239,0.12),transparent_70%)]" />
                <div className="relative flex flex-col items-center gap-4 px-4">
                  <BlobLoader size="lg" />
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <p className="text-center text-sm font-medium">
                      {progressMessage}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      );
    }
    if (posterUrl) {
      return (
        <div className={cn('flex w-full flex-col', wrapperClassName)}>
          <div
            className={cn(
              'relative overflow-hidden',
              className,
              getAspectRatioClassName(aspectRatio)
            )}
          >
            <AppImage
              src={posterUrl}
              alt=""
              width={imageDimensions.width}
              height={imageDimensions.height}
              className="h-full w-full object-cover"
            />
            <span className="absolute top-2 right-2 z-10 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              Preview
            </span>
          </div>
        </div>
      );
    }
    return (
      <div className={cn('flex w-full flex-col', wrapperClassName)}>
        <div className={cn(className, getAspectRatioClassName(aspectRatio))}>
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  if (!currentShot) {
    return (
      <EmptyState
        icon={<VideoIcon />}
        title={'No selected shot'}
        description={'Please select a shot to play.'}
      />
    );
  }

  // Get scene title for alt text — match scene-list-item fallback
  const currentScene = currentShot.sceneId
    ? scenes?.find((s) => s.id === currentShot.sceneId)
    : undefined;
  const sceneNumber = currentScene
    ? currentScene.orderIndex + 1
    : currentShotIndex >= 0
      ? currentShotIndex + 1
      : undefined;
  const title =
    currentScene?.title?.trim() ||
    (sceneNumber ? `Scene ${sceneNumber}` : undefined);

  // Best available image: override (variant preview) → final thumbnail → fast preview → sequence poster
  const displayImage =
    overrideImageUrl ??
    currentShot.image?.url ??
    currentShot.previewThumbnailUrl ??
    posterUrl ??
    null;
  const isPreviewImage =
    !!currentShot.previewThumbnailUrl && !currentShot.image?.url;
  const isVariantPreview =
    !!overrideImageUrl && overrideImageUrl !== currentShot.image?.url;

  // The image-focused tabs (the still image + the shot-variant grid) keep
  // showing the image; every other tab (script, motion, cast, location,
  // elements) shows the scene's video when one exists.
  const showsStillImage =
    selectedTab === 'image-prompt' || selectedTab === 'scene-variants';

  // Per-scene video-variant preview (#545): on the motion tab, play the
  // override variant for this shot instead of its primary video.
  const isVariantVideoPreview =
    !!overrideVideoUrl &&
    !showsStillImage &&
    overrideVideoUrl !== currentShot.video?.url;
  const playbackVideoUrl = showsStillImage
    ? ''
    : (overrideVideoUrl ?? currentShot.video?.url ?? '');

  return (
    <div className={cn('relative flex w-full flex-col', wrapperClassName)}>
      {hasFailedVideo ? (
        <div
          className={cn(
            'relative overflow-hidden',
            getAspectRatioClassName(aspectRatio),
            // Use bg-muted as fallback when no image at all
            !displayImage && 'bg-muted',
            className
          )}
        >
          {/* Show best available image as background */}
          {displayImage && (
            <a
              href={currentShot.image?.url ?? displayImage}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full h-full"
            >
              <AppImage
                src={displayImage}
                alt={title || 'Scene thumbnail'}
                className="w-full h-full object-cover"
                width={imageDimensions.width}
                height={imageDimensions.height}
              />
            </a>
          )}

          {/* Share dropdown */}
          {currentShot.image?.url && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 z-10 h-8 w-8 bg-black/50 text-white hover:bg-black/70"
                  aria-label="Share image"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void handleCopyImageUrl()}>
                  <Link className="h-4 w-4" />
                  Copy start frame URL
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <VideoStateOverlay
            thumbnailUrl={displayImage}
            videoStatus="failed"
            videoError={currentShot.primaryVideo?.error ?? null}
          />
          {frameOverlay}
        </div>
      ) : (
        <div
          className={cn(
            'relative w-full',
            getAspectRatioClassName(aspectRatio),
            className
          )}
        >
          {/* Share dropdown */}
          {(currentShot.image?.url || currentShot.video?.url) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 z-10 h-8 w-8 bg-black/50 text-white hover:bg-black/70"
                  aria-label="Share"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {currentShot.image?.url && (
                  <DropdownMenuItem onClick={() => void handleCopyImageUrl()}>
                    <Link className="h-4 w-4" />
                    Copy start frame URL
                  </DropdownMenuItem>
                )}
                {currentShot.video?.url && (
                  <DropdownMenuItem onClick={() => void handleCopyVideoUrl()}>
                    <VideoIcon className="h-4 w-4" />
                    Copy segment URL
                  </DropdownMenuItem>
                )}
                {hasCompletedVideo && downloadData?.downloadUrl && (
                  <DropdownMenuItem onClick={handleDownloadVideo}>
                    <Download className="h-4 w-4" />
                    Download segment video
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Clickable overlay to open the displayed image in a new tab — only
              when the poster (image) is what's showing, i.e. there's no
              playable video. Keyed off `playbackVideoUrl` (and href = the
              image actually displayed) so it never covers the video's play
              button or opens a different image than the poster. */}
          {displayImage && !playbackVideoUrl && (
            <a
              href={displayImage}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute inset-0 z-[5] cursor-pointer"
              aria-label="Open image in new tab"
            />
          )}
          <VideoPlayer
            // Remount when the selected shot OR the displayed media changes.
            // Image-tab stills use an empty src, so keying only on playbackVideoUrl
            // reused the previous shot's poster after a shot switch (#1070).
            key={`${currentShot.id}:${playbackVideoUrl || displayImage || ''}`}
            src={playbackVideoUrl}
            posterSrc={displayImage}
            aspectRatio={aspectRatio}
            className="h-full w-full"
            autoPlay={shouldAutoPlay}
            playSource="canvas"
            sequenceId={currentShot.sequenceId}
            shotId={currentShot.id}
            onTimeUpdate={onTimeUpdate}
            onPause={handlePause}
            onEnded={handleEnded}
          />
          {/* Show overlay for image/video generation states */}
          <VideoStateOverlay
            thumbnailUrl={displayImage}
            videoStatus={
              isVariantVideoPreview ? 'completed' : currentShot.videoStatus
            }
            imageStatus={currentShot.frame.imageStatus}
            imageError={currentShot.frame.imageError}
            videoError={currentShot.primaryVideo?.error ?? null}
            progressMessage={progressMessage}
            retry={retry}
          />
          {/* Status badges sit under the top-left frame-variants control so they
              don't cover it or the bottom video play controls (#1070). */}
          {badgeMessage && (
            <span className="absolute top-12 left-2 z-10 rounded bg-primary/80 px-2 py-1 text-xs font-medium text-primary-foreground backdrop-blur-sm">
              {badgeMessage}
            </span>
          )}
          {modelMismatchLabel && !badgeMessage && (
            <span className="absolute top-12 left-2 z-10 rounded bg-amber-500/90 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
              {modelMismatchLabel}
            </span>
          )}
          {staleLabel && !badgeMessage && !modelMismatchLabel && (
            <span className="absolute top-12 left-2 z-10 flex items-center gap-1.5 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
              />
              {staleLabel}
            </span>
          )}
          {isPreviewImage && !isVariantPreview && (
            <span className="absolute top-2 right-2 z-10 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              Storyboard
            </span>
          )}
          {frameOverlay}
        </div>
      )}
      {/* Sits just under the frame; CanvasMediaStage reserves a caption band
          so this is not clipped when 9:16 fills the stage (#1074). */}
      <p
        className={cn(
          'pointer-events-none absolute inset-x-0 top-full pt-1 text-center text-xs italic transition-opacity duration-300',
          isPreviewImage
            ? 'text-muted-foreground opacity-100'
            : 'opacity-0 select-none'
        )}
        aria-hidden={!isPreviewImage}
      >
        Fast preview — may not match the final image.
      </p>
      {/* Preload next video in background if it's completed */}
      {nextShot?.video?.url && nextShot.videoStatus === 'completed' && (
        <div className="hidden">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- preload only, not user-facing */}
          <video
            key={nextShot.video.url}
            src={nextShot.video.url}
            preload="auto"
          />
        </div>
      )}
    </div>
  );
};
