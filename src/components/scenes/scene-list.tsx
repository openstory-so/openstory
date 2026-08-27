import { ActionCost } from '@/components/billing/action-cost';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  type AudioModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import {
  estimateAudioCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { useFalPricing } from '@/hooks/use-fal-pricing';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { ShotVariant } from '@/lib/db/schema';
import { resolveShotDuration } from '@/lib/motion/resolve-shot-duration';
import type { SceneSelection } from '@/lib/scenes/scene-selection';
import type { SequenceSegment } from '@/lib/scenes/scene-segments';
import type { ShotView } from '@/lib/shots/shot-view';
import { cn } from '@/lib/utils';
import { Loader2, Video } from 'lucide-react';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SceneGroup } from './scene-group';
import { SceneListItem } from './scene-list-item';

/**
 * Center `el` in the nearest Radix ScrollArea viewport. Returns false when
 * the viewport has no height yet so the caller can retry after layout.
 *
 * Sets `scrollTop` on the viewport rather than calling `scrollIntoView`,
 * which would also scroll the page behind a sheet.
 */
function scrollIntoScrollArea(el: HTMLElement): boolean {
  const viewport = el.closest('[data-slot="scroll-area-viewport"]');
  if (!(viewport instanceof HTMLElement) || viewport.clientHeight === 0) {
    return false;
  }
  const y =
    el.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top +
    viewport.scrollTop;
  viewport.scrollTop = Math.max(
    0,
    y - (viewport.clientHeight - el.offsetHeight) / 2
  );
  return true;
}

function selectedListNode(
  root: HTMLElement,
  shotId: string | undefined,
  sceneId: string | undefined
): HTMLElement | null {
  if (shotId) {
    const node = root.querySelector(`[data-shot-id="${CSS.escape(shotId)}"]`);
    return node instanceof HTMLElement ? node : null;
  }
  if (!sceneId) return null;
  const node = root.querySelector(`[data-scene-id="${CSS.escape(sceneId)}"]`);
  return node instanceof HTMLElement ? node : null;
}

export type BatchGenerateMotionArgs = {
  includeMusic: boolean;
  musicModel: AudioModel;
  /** Batch override for every eligible shot (server `data.model`). */
  videoModel: ImageToVideoModel;
  /** Lets the user suppress model-emitted audio (sfx/dialogue/ambient) for the
   *  batch. The flag is honored only by models that produce audio — non-audio
   *  models ignore it downstream during motion-prompt assembly. */
  generateAudio: boolean;
};

export type SceneListProps = {
  shots?: ShotView[] | undefined;
  scenes?: SceneWithScript[] | undefined;
  /** Render segments (#986) — bracket the shots sharing one video per scene. */
  segments?: SequenceSegment[] | undefined;
  /** Shots/scenes query failure — shown instead of the list (never skeletons). */
  loadError?: Error | null;
  /** Segments query failure — brackets/stale badges are missing, say so. */
  segmentsError?: Error | null;
  selection: SceneSelection;
  aspectRatio: AspectRatio;
  onSelectScene: (sceneId: string, additive: boolean) => void;
  onClearSelection: () => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  hideBatchButton?: boolean;
  divergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  initialMusicModel?: AudioModel;
  /** Sequence default / last batch pick — seeds the motion model dropdown. */
  initialVideoModel?: ImageToVideoModel;
  /** Style-category gate for models that require a matching style. */
  styleCategory?: string;
  recommendedVideoModel?: string | null;
  styleName?: string;
  modelMissingShotIds?: Set<string>;
  modelMissingLabel?: string | null;
  /** Shots with stale prompts/image in the in-focus scene (#1077) — amber dots. */
  staleShotIds?: Set<string>;
  /** Sizing from the host — sidebar width on desktop, `w-full` in a sheet. */
  className?: string;
  /** Scroll the selected shot/scene into view on mount (mobile sheet). */
  scrollToSelection?: boolean;
};

const SceneListComponent: React.FC<SceneListProps> = ({
  shots,
  scenes,
  segments,
  loadError,
  segmentsError,
  selection,
  aspectRatio,
  onSelectScene,
  onClearSelection,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  divergentVariants,
  onCompareDivergent,
  initialMusicModel,
  initialVideoModel,
  styleCategory,
  recommendedVideoModel,
  styleName,
  modelMissingShotIds,
  modelMissingLabel,
  staleShotIds,
  className,
  scrollToSelection = false,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const divergentByShotId = useMemo(() => {
    const map = new Map<string, ShotVariant>();
    for (const v of divergentVariants ?? []) {
      // Image variant is what surfaces on the card. Other variant types
      // live on their respective tabs per the spec's surfacing matrix.
      if (v.variantType !== 'image') continue;
      if (!map.has(v.shotId)) map.set(v.shotId, v);
    }
    return map;
  }, [divergentVariants]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );
  const [videoModel, setVideoModel] = useState<ImageToVideoModel>(
    initialVideoModel ?? DEFAULT_VIDEO_MODEL
  );

  // Sync local selection when the sequence's saved model changes from outside
  // (e.g. after generation completes and the workflow persists the new model).
  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }
  const prevInitialVideoRef = useRef(initialVideoModel);
  if (initialVideoModel && initialVideoModel !== prevInitialVideoRef.current) {
    prevInitialVideoRef.current = initialVideoModel;
    setVideoModel(initialVideoModel);
  }

  const totalShots = shots?.length ?? 0;

  // Shots that need to be kicked off (not already generating)
  const notStartedShots = useMemo(() => {
    if (!shots) return [];
    return shots.filter(
      (f) =>
        (f.videoStatus === 'pending' || f.videoStatus === 'failed') &&
        f.frame.imageStatus === 'completed'
    );
  }, [shots]);

  const hasGeneratingShots = useMemo(() => {
    if (!shots) return false;
    return shots.some(
      (f) =>
        f.videoStatus === 'generating' && f.frame.imageStatus === 'completed'
    );
  }, [shots]);

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!notStartedShots.length) return true;
    return notStartedShots.every((f) => f.motionPrompt?.fullPrompt);
  }, [notStartedShots]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || notStartedShots.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion({
        includeMusic,
        musicModel,
        videoModel,
        generateAudio,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const isMotionInProgress = regeneratingMotion.size > 0 || hasGeneratingShots;
  const showButton =
    !hideBatchButton && notStartedShots.length > 0 && !isMotionInProgress;
  const isButtonDisabled =
    isGenerating ||
    notStartedShots.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  // Batch cost = sum of per-shot motion at the selected video model
  // (+ optional music track) (#1140). Matches server `data.model` override.
  const { pricing: falPricing } = useFalPricing();
  const batchCostEstimate = useMemo((): Microdollars | null => {
    if (!falPricing || notStartedShots.length === 0) return null;
    let total: Microdollars = ZERO_MICROS;
    let anyHonest = false;
    for (const shot of notStartedShots) {
      const duration = resolveShotDuration({
        durationMs: shot.durationMs,
        model: videoModel,
      });
      // Sequences with completed stills almost always have cast/element refs
      // by motion time; Seedance routes to reference-to-video when they do.
      const perShot = estimateVideoCost(videoModel, duration, {
        pricing: falPricing,
        hasReferenceImages: true,
      });
      if (perShot === null) continue;
      anyHonest = true;
      total = addMicros(total, perShot);
    }
    if (includeMusic) {
      const audioDuration = notStartedShots.reduce((sum, shot) => {
        return (
          sum +
          resolveShotDuration({
            durationMs: shot.durationMs,
            model: videoModel,
          })
        );
      }, 0);
      const music = estimateAudioCost(musicModel, Math.max(audioDuration, 5), {
        pricing: falPricing,
      });
      if (music !== null) {
        anyHonest = true;
        total = addMicros(total, music);
      }
    }
    return anyHonest ? total : null;
  }, [falPricing, notStartedShots, includeMusic, musicModel, videoModel]);

  const shotsBySceneId = useMemo(() => {
    const map = new Map<string, ShotView[]>();
    for (const shot of shots ?? []) {
      if (!shot.sceneId) continue;
      const list = map.get(shot.sceneId) ?? [];
      list.push(shot);
      map.set(shot.sceneId, list);
    }
    return map;
  }, [shots]);

  // Shots without a scene row (sequences predating the scenes table) still
  // render — dropping them would silently hide selectable shots.
  const unassignedShots = useMemo(
    () => (shots ?? []).filter((shot) => !shot.sceneId),
    [shots]
  );

  const groupedScenes = useMemo(() => {
    if (!scenes?.length) return [];
    return scenes.map((scene) => ({
      scene,
      shots: shotsBySceneId.get(scene.id) ?? [],
    }));
  }, [scenes, shotsBySceneId]);

  const isLoading = shots === undefined || scenes === undefined;

  const segmentsById = useMemo(() => {
    const map = new Map<string, SequenceSegment>();
    for (const segment of segments ?? []) map.set(segment.id, segment);
    return map;
  }, [segments]);

  const isWholeSequence = selection.sceneIds.length === 0 && !selection.shotId;
  const selectedShotId = selection.shotId;
  const selectedSceneId = selectedShotId ? undefined : selection.sceneIds[0];

  useLayoutEffect(() => {
    if (!scrollToSelection || isLoading) return;
    const root = rootRef.current;
    if (!root) return;

    const target = selectedListNode(root, selectedShotId, selectedSceneId);
    if (!target) {
      const viewport = root.querySelector('[data-slot="scroll-area-viewport"]');
      if (viewport instanceof HTMLElement) viewport.scrollTop = 0;
      return;
    }

    let attempts = 0;
    let frame = 0;
    const tryScroll = () => {
      if (scrollIntoScrollArea(target) || ++attempts > 20) return;
      frame = requestAnimationFrame(tryScroll);
    };
    tryScroll();
    return () => cancelAnimationFrame(frame);
  }, [scrollToSelection, isLoading, selectedShotId, selectedSceneId]);

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-background',
        className
      )}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Scenes
        </h2>
      </div>

      <button
        type="button"
        onClick={onClearSelection}
        title={
          isWholeSequence
            ? 'Whole sequence selected'
            : 'Show the whole sequence (Esc zooms out one level at a time)'
        }
        className={cn(
          'border-b px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/40',
          isWholeSequence && 'bg-primary/5 font-medium text-primary'
        )}
      >
        Whole sequence
      </button>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-3 p-4">
          {loadError && (
            <p role="alert" className="text-sm text-destructive">
              Failed to load scenes: {loadError.message}
            </p>
          )}

          {!loadError && segmentsError && (
            <p role="alert" className="text-xs text-destructive">
              Failed to load video segments: {segmentsError.message}
            </p>
          )}

          {!loadError &&
            isLoading &&
            [1, 2, 3].map((i) => (
              <div
                key={`scene-skeleton-${i}`}
                className="h-20 animate-pulse rounded-lg border bg-muted/40"
              />
            ))}

          {!loadError &&
            !isLoading &&
            groupedScenes.length === 0 &&
            unassignedShots.length === 0 && (
              <p className="text-sm text-muted-foreground">No scenes yet.</p>
            )}

          {groupedScenes.map(({ scene, shots: sceneShots }) => (
            <SceneGroup
              key={scene.id}
              scene={scene}
              shots={sceneShots}
              segmentsById={segmentsById}
              isSceneSelected={selection.sceneIds.includes(scene.id)}
              selectedShotId={selection.shotId}
              aspectRatio={aspectRatio}
              onSelectScene={onSelectScene}
              regeneratingImages={regeneratingImages}
              regeneratingMotion={regeneratingMotion}
              divergentByShotId={divergentByShotId}
              onCompareDivergent={onCompareDivergent}
              modelMissingShotIds={modelMissingShotIds}
              modelMissingLabel={modelMissingLabel}
              staleShotIds={staleShotIds}
            />
          ))}

          {unassignedShots.map((shot) => {
            const divergent = divergentByShotId.get(shot.id);
            return (
              <SceneListItem
                key={shot.id}
                shot={shot}
                aspectRatio={aspectRatio}
                isActive={shot.id === selection.shotId}
                variant="horizontal"
                isRegeneratingImage={regeneratingImages.has(shot.id)}
                isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                divergentVariantId={divergent?.id}
                onCompareDivergent={
                  divergent ? () => onCompareDivergent?.(divergent) : undefined
                }
                modelMissing={
                  !!modelMissingLabel &&
                  (modelMissingShotIds?.has(shot.id) ?? false)
                }
                modelMissingLabel={modelMissingLabel}
                isStale={staleShotIds?.has(shot.id) ?? false}
              />
            );
          })}
        </div>
      </ScrollArea>

      {/* Sticky footer with Generate Motion button */}
      {showButton && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          <MotionModelSelector
            selectedModel={videoModel}
            onModelChange={setVideoModel}
            aspectRatio={aspectRatio}
            styleCategory={styleCategory}
            recommendedVideoModel={recommendedVideoModel}
            styleName={styleName}
            disabled={isGenerating || isMotionInProgress}
          />
          {includeMusic && (
            <MusicModelSelector
              selectedModel={musicModel}
              onModelChange={setMusicModel}
              disabled={isGenerating || isMotionInProgress}
            />
          )}
          <div className="flex flex-col gap-1">
            <Button
              variant="default"
              className="w-full"
              onClick={() => void handleGenerateMotion()}
              disabled={isButtonDisabled}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : !motionPromptsReady ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Writing motion prompts…
                </>
              ) : includeMusic && !musicPromptsReady ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Composing music…
                </>
              ) : (
                <>
                  <Video className="mr-2 h-4 w-4" />
                  Generate {notStartedShots.length} / {totalShots}{' '}
                  {totalShots === 1 ? 'shot' : 'shots'}
                </>
              )}
            </Button>
            <ActionCost estimate={batchCostEstimate} />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeMusic}
              onCheckedChange={(checked) => setIncludeMusic(checked === true)}
              disabled={!musicPromptsReady}
            />
            <span>
              Also generate music
              {!musicPromptsReady && (
                <span className="text-xs ml-1">(preparing…)</span>
              )}
            </span>
          </label>
          <label
            htmlFor="batch-generate-audio"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Checkbox
              id="batch-generate-audio"
              checked={generateAudio}
              onCheckedChange={(checked) => setGenerateAudio(checked === true)}
            />
            <span>Include SFX &amp; dialogue (when the model supports it)</span>
          </label>
        </div>
      )}
    </div>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling.
// Relies on TanStack Query's structural sharing to preserve object references.
const areEqual = (
  prevProps: SceneListProps,
  nextProps: SceneListProps
): boolean => {
  if (
    prevProps.selection !== nextProps.selection ||
    prevProps.scenes !== nextProps.scenes ||
    prevProps.segments !== nextProps.segments ||
    prevProps.loadError !== nextProps.loadError ||
    prevProps.segmentsError !== nextProps.segmentsError ||
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady ||
    prevProps.hideBatchButton !== nextProps.hideBatchButton ||
    prevProps.initialMusicModel !== nextProps.initialMusicModel ||
    prevProps.initialVideoModel !== nextProps.initialVideoModel ||
    prevProps.styleCategory !== nextProps.styleCategory ||
    prevProps.recommendedVideoModel !== nextProps.recommendedVideoModel ||
    prevProps.styleName !== nextProps.styleName ||
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel ||
    prevProps.modelMissingShotIds !== nextProps.modelMissingShotIds ||
    prevProps.staleShotIds !== nextProps.staleShotIds ||
    prevProps.className !== nextProps.className
  ) {
    return false;
  }

  if (
    prevProps.regeneratingImages !== nextProps.regeneratingImages ||
    prevProps.regeneratingMotion !== nextProps.regeneratingMotion
  ) {
    return false;
  }

  if (
    prevProps.onBatchGenerateMotion !== nextProps.onBatchGenerateMotion ||
    prevProps.onCompareDivergent !== nextProps.onCompareDivergent ||
    prevProps.onSelectScene !== nextProps.onSelectScene ||
    prevProps.onClearSelection !== nextProps.onClearSelection
  ) {
    return false;
  }

  if (prevProps.divergentVariants !== nextProps.divergentVariants) {
    return false;
  }

  // TanStack Query's structural sharing keeps the array reference stable when
  // the contents are unchanged, so reference equality is sufficient.
  if (prevProps.shots === nextProps.shots) {
    return true;
  }
  if (!prevProps.shots || !nextProps.shots) {
    return false;
  }
  if (prevProps.shots.length !== nextProps.shots.length) {
    return false;
  }
  for (let i = 0; i < prevProps.shots.length; i++) {
    if (prevProps.shots[i] !== nextProps.shots[i]) {
      return false;
    }
  }

  return true;
};

export const SceneList = memo(SceneListComponent, areEqual);
