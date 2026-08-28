import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import { plainSceneTitle, stripMarkdown } from '@/lib/utils/markdown-plain';
import type { ShotView } from '@/lib/shots/shot-view';
import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  MoreVertical,
  Play,
  Trash2,
} from 'lucide-react';
import { memo } from 'react';
import { SceneThumbnail } from './scene-thumbnail';

type SceneListItemProps = {
  shot?: ShotView | undefined;
  /** The shot's scene — carries the number, title and script the card shows. */
  scene?: SceneWithScript | undefined;
  aspectRatio: AspectRatio;
  isActive?: boolean;
  /** Fires after the click; navigation is the card's own link. */
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
  /**
   * Prompts/image out of date since the last edit (#1077) — quiet amber
   * corner dot. Divergent alternates and the regen spinner take precedence.
   */
  isStale?: boolean;
  /** Structure controls (#1108) — the shot menu renders when any is set. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRequestDelete?: () => void;
};

const SceneListItemComponent: React.FC<SceneListItemProps> = ({
  shot,
  scene,
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
  isStale = false,
  onMoveUp,
  onMoveDown,
  onRequestDelete,
}) => {
  const hasShotMenu = !!(onMoveUp || onMoveDown || onRequestDelete);
  // Divergent alternate takes precedence: promoting it resolves staleness too.
  const showDivergentDot = !!divergentVariantId;
  // Motion state lives on the thumbnail as a play badge: solid = the shot has
  // a video, pulsing = motion is generating. Image regeneration keeps the
  // corner spinner (the thumbnail itself is what's being replaced). The old
  // corner tick is gone — a green check on every finished shot was noise on a
  // list where "finished" is the normal state.
  const hasVideo = shot?.videoStatus === 'completed' && !!shot.video?.url;
  const isGeneratingVideo =
    !!shot && (shot.videoStatus === 'generating' || isRegeneratingMotion);
  const sceneNumber = (scene?.orderIndex ?? 0) + 1;
  const title = !shot
    ? undefined
    : plainSceneTitle(scene?.title) || `Scene ${sceneNumber}`;
  const scriptPreview = !shot
    ? undefined
    : stripMarkdown(scene?.script?.extract ?? '');

  // Skeleton state (no shot): no link, no pointer cursor.
  const isSkeleton = !shot;
  return (
    <Card
      data-testid="scene-list-item"
      data-shot-id={shot?.id}
      className={cn(
        '@container/scene group/scene-item relative transition-all',
        isSkeleton ? 'pointer-events-none' : 'cursor-pointer',
        isActive ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
        variant === 'responsive' && '@[280px]/scene:py-3',
        variant === 'horizontal' && 'py-3',
        'py-3'
      )}
    >
      {shot && (
        // Stretched link: a real <a href> so the click works before hydration,
        // from the keyboard, and with Cmd/middle-click (#1339). Selection is
        // URL state (`?shot=`), so this is the same navigate `useSceneSelection`
        // does. z-10 puts it above the thumbnail wrapper; the corner dot comes
        // later in the DOM so it still wins.
        <Link
          from="/sequences/$id/scenes"
          search={(prev) => ({ ...prev, scenes: undefined, shot: shot.id })}
          aria-label={title}
          className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onSelect}
        />
      )}
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
                thumbnailUrl={shot?.image?.url}
                previewThumbnailUrl={shot?.previewThumbnailUrl}
                thumbnailStatus={shot?.frame.imageStatus || undefined}
                generationError={shot?.frame.imageError}
                alt={title ?? 'Scene thumbnail'}
                aspectRatio={aspectRatio}
                className="w-full rounded-md"
                gridSheetUrl={shot?.gridSheet?.url}
                pendingUpscaleIndex={shot?.pendingUpscaleIndex}
                pendingUpscaleUrl={shot?.pendingUpscaleUrl}
              />
              {!showDivergentDot && shot && !isRegeneratingImage && isStale && (
                <span
                  className="pointer-events-none absolute top-1 right-1"
                  title="Out of date since your last edit"
                >
                  <span className="sr-only">
                    Out of date since your last edit
                  </span>
                  <span
                    aria-hidden="true"
                    className="block h-2 w-2 rounded-full bg-amber-500 ring-2 ring-amber-500/30"
                  />
                </span>
              )}
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

      {hasShotMenu && shot && (
        <div
          className="absolute bottom-2 right-2 z-20"
          // Halt propagation so opening the menu doesn't also follow the
          // stretched card link (z-10) underneath.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/scene-item:opacity-100 data-[state=open]:opacity-100"
                aria-label="Shot actions"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!onMoveUp} onClick={onMoveUp}>
                <ArrowUp className="h-4 w-4" />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!onMoveDown} onClick={onMoveDown}>
                <ArrowDown className="h-4 w-4" />
                Move down
              </DropdownMenuItem>
              {onRequestDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={onRequestDelete}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove shot
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
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
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel ||
    prevProps.isStale !== nextProps.isStale
  ) {
    return false;
  }

  // Menu availability flips when a shot becomes first/last after a reorder —
  // presence (not identity) is what the render reads.
  if (
    !!prevProps.onMoveUp !== !!nextProps.onMoveUp ||
    !!prevProps.onMoveDown !== !!nextProps.onMoveDown ||
    !!prevProps.onRequestDelete !== !!nextProps.onRequestDelete
  ) {
    return false;
  }

  // Scene fields used in render: number, title, script extract.
  const prevScene = prevProps.scene;
  const nextScene = nextProps.scene;
  if (prevScene !== nextScene) {
    if (!prevScene || !nextScene) {
      return false;
    }
    if (
      prevScene.orderIndex !== nextScene.orderIndex ||
      prevScene.title !== nextScene.title ||
      prevScene.script?.extract !== nextScene.script?.extract
    ) {
      return false;
    }
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
    prevShot.image?.url !== nextShot.image?.url ||
    prevShot.previewThumbnailUrl !== nextShot.previewThumbnailUrl ||
    prevShot.frame.imageStatus !== nextShot.frame.imageStatus ||
    prevShot.frame.imageError !== nextShot.frame.imageError ||
    prevShot.gridSheet?.url !== nextShot.gridSheet?.url ||
    prevShot.pendingUpscaleIndex !== nextShot.pendingUpscaleIndex ||
    prevShot.pendingUpscaleUrl !== nextShot.pendingUpscaleUrl
  ) {
    return false;
  }

  // Check video-related fields (for skeleton/completion state)
  if (
    prevShot.video?.url !== nextShot.video?.url ||
    prevShot.videoStatus !== nextShot.videoStatus
  ) {
    return false;
  }

  if (prevShot.shotNumber !== nextShot.shotNumber) {
    return false;
  }

  // All checks passed - props are equal
  return true;
};

export const SceneListItem = memo(SceneListItemComponent, areEqual);
