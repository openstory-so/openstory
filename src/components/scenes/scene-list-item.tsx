import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import { stripMarkdown } from '@/lib/utils/markdown-plain';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { Loader2, Play } from 'lucide-react';
import { memo } from 'react';
import { SceneThumbnail } from './scene-thumbnail';

type SceneListItemProps = {
  shot?: ShotWithImage | undefined;
  aspectRatio: AspectRatio;
  isActive?: boolean;
  onSelect?: () => void;
  variant?: 'stacked' | 'horizontal' | 'responsive';
  isRegeneratingImage?: boolean;
  isRegeneratingMotion?: boolean;
  /**
   * Set when the shot has a divergent alternate thumbnail awaiting review.
   * Takes precedence over the staleness dot per the divergence-resolution
   * spec — promoting the alternate resolves both states.
   */
  divergentVariantId?: string;
  onCompareDivergent?: () => void;
  /** Pinned image model hasn't generated this scene (#547) — show a badge. */
  modelMissing?: boolean;
  /** Name of the pinned image model, for the "No {model}" badge. */
  modelMissingLabel?: string | null;
};

const SceneListItemComponent: React.FC<SceneListItemProps> = ({
  shot,
  aspectRatio,
  isActive = false,
  onSelect,
  variant = 'responsive',
  isRegeneratingImage = false,
  isRegeneratingMotion = false,
  divergentVariantId,
  onCompareDivergent,
  modelMissing = false,
  modelMissingLabel,
}) => {
  // Divergent alternate takes precedence: promoting it resolves staleness too.
  const showDivergentDot = !!divergentVariantId;
  // Motion state lives on the thumbnail as a play badge: solid = the shot has
  // a video, pulsing = motion is generating. Image regeneration keeps the
  // corner spinner (the thumbnail itself is what's being replaced).
  const hasVideo = shot?.videoStatus === 'completed' && !!shot.videoUrl;
  const isGeneratingVideo =
    !!shot && (shot.videoStatus === 'generating' || isRegeneratingMotion);
  // Extract scene data from shot metadata
  const metadata = shot?.metadata;

  const sceneNumber = metadata?.sceneNumber ?? (shot?.orderIndex ?? 0) + 1;
  const title = !shot
    ? undefined
    : (metadata?.metadata?.title ?? `Scene ${sceneNumber}`);
  const scriptPreview = !shot
    ? undefined
    : stripMarkdown(metadata?.originalScript.extract ?? shot.description ?? '');

  // Skeleton state (no shot): suppress click handling and pointer cursor so
  // a click during the loading window does not invoke the (now-undefined)
  // onSelect callback or appear interactive.
  const isSkeleton = !shot;
  return (
    <Card
      data-testid="scene-list-item"
      data-shot-id={shot?.id}
      className={cn(
        '@container/scene relative transition-all',
        isSkeleton ? 'pointer-events-none' : 'cursor-pointer',
        // Selection = scope: match the selected scene header's treatment so
        // "selected" reads the same at every level of the spine. The playhead
        // is only marked in the player's filmstrip — a second rectangle here
        // read as a phantom selection (#986).
        isActive ? 'border-primary bg-primary/10' : 'hover:bg-muted/50',
        variant === 'responsive' && '@[280px]/scene:py-3',
        variant === 'horizontal' && 'py-3',
        'py-3'
      )}
      onClick={isSkeleton ? undefined : onSelect}
    >
      {showDivergentDot && (
        <div
          className="absolute right-3 top-3 z-10"
          // The corner indicator is itself a focusable button; this wrapper
          // exists only to halt click propagation so opening the dot doesn't
          // also select the scene card behind it.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <DivergentAlternateBanner
            density="corner-dot"
            variantId={divergentVariantId}
            artifact="thumbnail"
            entityType="shot"
            onCompare={() => onCompareDivergent?.()}
            // Compare-only entry from the corner; promote/discard live in the dialog.
            onPromote={() => onCompareDivergent?.()}
            onDiscard={() => onCompareDivergent?.()}
          />
        </div>
      )}
      {!showDivergentDot && shot && isRegeneratingImage && (
        <Loader2
          className={cn(
            'absolute right-4 top-4 z-10 h-6 w-6 p-1 rounded-full animate-spin',
            'bg-primary/10 text-primary'
          )}
        />
      )}

      <CardHeader>
        <div
          className={cn(
            'flex flex-col gap-3',
            variant === 'responsive' &&
              '@[280px]/scene:flex-row @[280px]/scene:gap-4',
            variant === 'horizontal' && 'flex-row gap-4'
          )}
        >
          <div
            className={cn(
              'w-full',
              aspectRatio === '9:16' && [
                variant === 'responsive' &&
                  '@[280px]/scene:w-20 @[280px]/scene:shrink-0',
                variant === 'horizontal' && 'w-20 shrink-0',
              ],
              aspectRatio !== '9:16' && [
                variant === 'responsive' &&
                  '@[280px]/scene:w-32 @[280px]/scene:shrink-0',
                variant === 'horizontal' && 'w-32 shrink-0',
              ]
            )}
          >
            {/* Badges anchor to the thumbnail, not the (taller) text row. */}
            <div className="relative">
              <SceneThumbnail
                thumbnailUrl={shot?.thumbnailUrl}
                previewThumbnailUrl={shot?.previewThumbnailUrl}
                thumbnailStatus={shot?.thumbnailStatus || undefined}
                alt={title ?? 'Scene thumbnail'}
                aspectRatio={aspectRatio}
                className="w-full rounded-md"
              />
              {(hasVideo || isGeneratingVideo) && (
                <span
                  aria-label={
                    isGeneratingVideo ? 'Generating motion…' : 'Motion ready'
                  }
                  className={cn(
                    'absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-background/60 text-foreground/80',
                    isGeneratingVideo && 'motion-safe:animate-pulse'
                  )}
                >
                  <Play className="h-2.5 w-2.5 fill-current" />
                </span>
              )}
              {modelMissing && (
                <span
                  className="absolute bottom-1 left-1 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                  aria-label={
                    modelMissingLabel
                      ? `Not generated with ${modelMissingLabel}`
                      : 'Not generated with the selected model'
                  }
                >
                  No {modelMissingLabel}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-sm">
              {title ?? <Skeleton className="w-24 h-4" />}
            </CardTitle>
            <CardDescription className="line-clamp-4 text-xs leading-snug">
              {scriptPreview ?? <Skeleton className="w-full h-4" />}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling
// Only re-render if the fields that affect the UI actually change
const areEqual = (
  prevProps: SceneListItemProps,
  nextProps: SceneListItemProps
): boolean => {
  // Compare primitive props
  if (
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.isActive !== nextProps.isActive ||
    prevProps.variant !== nextProps.variant ||
    prevProps.isRegeneratingImage !== nextProps.isRegeneratingImage ||
    prevProps.isRegeneratingMotion !== nextProps.isRegeneratingMotion ||
    prevProps.divergentVariantId !== nextProps.divergentVariantId ||
    prevProps.modelMissing !== nextProps.modelMissing ||
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel
  ) {
    return false;
  }

  // If both shots are undefined, they're equal
  if (!prevProps.shot && !nextProps.shot) {
    return true;
  }

  // If one is undefined and the other isn't, they're not equal
  if (!prevProps.shot || !nextProps.shot) {
    return false;
  }

  // Compare shot fields that affect rendering
  const prevShot = prevProps.shot;
  const nextShot = nextProps.shot;

  // Check if shot identity changed
  if (prevShot.id !== nextShot.id) {
    return false;
  }

  // Check thumbnail-related fields
  if (
    prevShot.thumbnailUrl !== nextShot.thumbnailUrl ||
    prevShot.previewThumbnailUrl !== nextShot.previewThumbnailUrl ||
    prevShot.thumbnailStatus !== nextShot.thumbnailStatus
  ) {
    return false;
  }

  // Check video-related fields (for skeleton/completion state)
  if (
    prevShot.videoUrl !== nextShot.videoUrl ||
    prevShot.videoStatus !== nextShot.videoStatus
  ) {
    return false;
  }

  // Check metadata fields used in render
  if (prevShot.orderIndex !== nextShot.orderIndex) {
    return false;
  }

  if (prevShot.description !== nextShot.description) {
    return false;
  }

  // Check metadata object (scene data)
  const prevMetadata = prevShot.metadata;
  const nextMetadata = nextShot.metadata;

  if (!prevMetadata && !nextMetadata) {
    return true;
  }

  if (!prevMetadata || !nextMetadata) {
    return false;
  }

  // Compare the metadata fields we use: sceneNumber, title, script extract
  if (
    prevMetadata.sceneNumber !== nextMetadata.sceneNumber ||
    prevMetadata.metadata?.title !== nextMetadata.metadata?.title ||
    prevMetadata.originalScript.extract !== nextMetadata.originalScript.extract
  ) {
    return false;
  }

  // All checks passed - props are equal
  return true;
};

export const SceneListItem = memo(SceneListItemComponent, areEqual);
