import { ActionCost } from '@/billing/ui/action-cost';
import { GenerationStopSlider } from '@/sequences/ui/generation/generation-stop-slider';
import { MotionModelSelector } from '@/models/ui/pickers/motion-model-selector';
import { MusicModelSelector } from '@/models/ui/pickers/music-model-selector';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import {
  actionLabelForStage,
  continueStartFrom,
  DEFAULT_GENERATION_STOP_AT,
  isContinueStage,
  stageIndex,
  type ContinueStage,
  type GenerationStage,
} from '@/sequences/pipeline';
import { useHydrated } from '@/ui/use-hydrated';
import { useCreateScene, useReorderScenes } from './use-scene-structure';
import {
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidImageToVideoModel,
  supportsDraftMode,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import {
  DRAFT_FINAL_RESOLUTION,
  DRAFT_RESOLUTION,
  draftTaskUsable,
} from '@/motion/draft-mode';
import {
  estimateAudioCost,
  estimateVideoCost,
} from '@/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { useFalPricing } from '@/billing/ui/use-fal-pricing';
import { useVoiceDesignAvailable } from '@/cast/ui/use-voice-design-available';
import { useGenerationSliceEstimate } from '@/sequences/ui/use-sequences';
import type { SceneWithScript } from './use-scenes';
import type { ShotVariant } from '@/platform/server/db/schema';
import { errorMessage } from '@/platform/errors';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import type { SceneSelection } from './scene-selection';
import type { SequenceSegment } from '@/shots/scene-segments';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import {
  isBatchMotionEligible,
  isMotionGenerating,
  type ShotView,
} from '@/shots/shot-view';
import { cn } from '@/ui/utils';
import {
  CirclePlay,
  FileText,
  Images,
  Loader2,
  Mic,
  Music,
  PanelLeftClose,
  Plus,
  Video,
  Sparkles,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { SceneGroup, sumShotSeconds } from './scene-group';
import { TargetDurationChip } from '@/sequences/ui/target-duration-chip';
import { SceneListItem } from './scene-list-item';

const CONTINUE_ICON = {
  script: FileText,
  references: Images,
  images: Images,
  dialogue: Mic,
  motion: Video,
  music: Music,
} as const;

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
  const rect = el.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  // Already in view: leave the list where the user scrolled it.
  if (rect.top >= view.top && rect.bottom <= view.bottom) return true;
  const y = rect.top - view.top + viewport.scrollTop;
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
  /** Render the batch as Ark drafts (#1756); persisted on the sequence. */
  draftMotion: boolean;
};

export type SceneListProps = {
  sequenceId: string;
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
  /** Output resolution tier (#1449) — sizes the batch-motion estimate. */
  resolution?: Resolution;
  onSelectScene: (sceneId: string, additive: boolean) => void;
  onSelectShot: (shotId: string) => void;
  onClearSelection: () => void;
  /** Zoom out to the sequence player and switch the centre column to canvas. */
  onPlaySequence?: () => void;
  /** Shot under the sequence player's playhead (#1771) — marked and kept in view. */
  playingShotId?: string;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  nextStage?: GenerationStage | null;
  onContinueGeneration?: (args: {
    startFrom: ContinueStage;
    stopAt: GenerationStage;
    generateStartFrames: boolean;
    generateVoices: boolean;
  }) => Promise<void>;
  onGenerateMusic?: (model: AudioModel) => Promise<void>;
  musicPromptsReady: boolean;
  hideBatchButton?: boolean;
  divergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  initialMusicModel?: AudioModel;
  /** Sequence default / last batch pick — seeds the motion model dropdown. */
  initialVideoModel?: ImageToVideoModel;
  /**
   * Persist a generate-shots model pick as the sequence default so
   * ungenerated shots and Sequence settings follow it immediately.
   */
  onVideoModelChange?: (model: ImageToVideoModel) => void;
  /** Sequence stills model — continue-from-DAG cost quotes. */
  initialImageModel?: TextToImageModel;
  /** Style-category gate for models that require a matching style. */
  styleCategory?: string;
  /**
   * Sequence renders straight to video with no stills, so shot eligibility
   * cannot require one — see `isBatchMotionEligible`.
   */
  generateStartFrames?: boolean;
  /** Match the initial Generate dialog’s Dialogue stop. */
  generateVoices?: boolean;
  styleName?: string;
  /** Shots with stale prompts/image (#1077) — amber dots on every rail thumbnail. */
  staleShotIds?: Set<string>;
  /** Desktop sidebar only: fold the list to the thumbnail rail (#1713). */
  onCollapse?: () => void;
  /** Sizing from the host — sidebar width on desktop, `w-full` in a sheet. */
  className?: string;
  /** Scroll the selected shot/scene into view on mount (mobile sheet). */
  scrollToSelection?: boolean;
  /** `sequences.targetDurationSeconds` for the rail chip (#1593); null = auto. */
  targetDurationSeconds?: number | null;
  /** A run is on: scenes with no shots yet read "listing shots…" (#1593). */
  isAnalyzing?: boolean;
  leftoverGrokShotIds?: ReadonlySet<string>;
  onLeftoverGrokChange?: (shotIds: readonly string[], useGrok: boolean) => void;
  /** Remaining / total on-screen sheets when continue starts at References. */
  referenceProgress?: { remaining: number; total: number };
  /** The sequence's draft-mode setting (#1756); seeds the batch checkbox. */
  draftMotion?: boolean;
  /** Render every approved draft at quality (#1756). */
  onRenderDraftsAtQuality?: () => Promise<void>;
};

const SceneListComponent: React.FC<SceneListProps> = ({
  sequenceId,
  shots,
  scenes,
  segments,
  loadError,
  segmentsError,
  selection,
  aspectRatio,
  resolution,
  onSelectScene,
  onSelectShot,
  onClearSelection,
  onPlaySequence,
  playingShotId,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  nextStage = null,
  onContinueGeneration,
  onGenerateMusic,
  musicPromptsReady,
  hideBatchButton = false,
  divergentVariants,
  onCompareDivergent,
  initialMusicModel,
  initialVideoModel,
  onVideoModelChange,
  initialImageModel: _initialImageModel,
  styleCategory,
  generateStartFrames = false,
  generateVoices = false,
  styleName,
  staleShotIds,
  onCollapse,
  className,
  scrollToSelection = false,
  targetDurationSeconds,
  isAnalyzing = false,
  leftoverGrokShotIds,
  onLeftoverGrokChange,
  referenceProgress,
  draftMotion = false,
  onRenderDraftsAtQuality,
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

  const createScene = useCreateScene(sequenceId);
  // The rail is in the SSR markup, so a click can land before React has
  // attached the handler and silently do nothing (the manual-pipeline e2e
  // hit this under parallel workers). Same gate as the library Add buttons.
  const isHydrated = useHydrated();
  const reorderScenes = useReorderScenes(sequenceId);

  // Scene order lives in the scenes array; a ref keeps a stale closure in a
  // memoized child operating on the CURRENT order (same pattern as shots).
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const handleMoveScene = useCallback(
    (sceneId: SceneWithScript['id'], direction: 'up' | 'down') => {
      const ids = (scenesRef.current ?? []).map((s) => s.id);
      const index = ids.indexOf(sceneId);
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || swapWith < 0 || swapWith >= ids.length) return;
      const next = [...ids];
      const a = next[index];
      const b = next[swapWith];
      if (a === undefined || b === undefined) return;
      next[index] = b;
      next[swapWith] = a;
      reorderScenes.mutate(next, {
        onError: (error) =>
          toast.error('Failed to reorder scenes', {
            description: errorMessage(error),
          }),
      });
    },
    [reorderScenes]
  );

  const handleAddScene = () => {
    createScene.mutate(undefined, {
      onSuccess: ({ scene }) => {
        onSelectScene(scene.id, false);
      },
      onError: (error) =>
        toast.error('Failed to add scene', {
          description: errorMessage(error),
        }),
    });
  };

  const [isGenerating, setIsGenerating] = useState(false);
  const [continueStopAt, setContinueStopAt] = useState<GenerationStage>(
    nextStage ?? DEFAULT_GENERATION_STOP_AT
  );
  const [draftStartFrames, setDraftStartFrames] = useState(generateStartFrames);
  const [draftVoices, setDraftVoices] = useState(generateVoices);
  useEffect(() => {
    if (nextStage) setContinueStopAt(nextStage);
  }, [nextStage]);
  useEffect(() => {
    setDraftStartFrames(generateStartFrames);
  }, [generateStartFrames]);
  useEffect(() => {
    setDraftVoices(generateVoices);
  }, [generateVoices]);
  const voicesUnavailable = useVoiceDesignAvailable() === false;
  const voices = voicesUnavailable ? false : draftVoices;
  const [includeMusic, setIncludeMusic] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [draftBatch, setDraftBatch] = useState(draftMotion);
  useEffect(() => {
    setDraftBatch(draftMotion);
  }, [draftMotion]);
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

  // Shots that need to be kicked off (not already generating). 'cancelled'
  // is user-initiated (#1108 Phase 4): deliberately eligible for a
  // user-driven batch generate, never auto-retried.
  const notStartedShots = useMemo(() => {
    if (!shots) return [];
    return shots.filter((f) =>
      isBatchMotionEligible(f, rendersReferenceOnly(f, { generateStartFrames }))
    );
  }, [shots, generateStartFrames]);

  // The batch's mode: one reference-only shot in it decides the model list,
  // because submit checks the picked model against every such shot.
  const batchRendersReferenceOnly = useMemo(
    () =>
      notStartedShots.some((f) =>
        rendersReferenceOnly(f, { generateStartFrames })
      ),
    [notStartedShots, generateStartFrames]
  );

  const hasGeneratingShots = useMemo(() => {
    if (!shots) return false;
    return shots.some((f) =>
      isMotionGenerating(f, rendersReferenceOnly(f, { generateStartFrames }))
    );
  }, [shots, generateStartFrames]);

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!notStartedShots.length) return true;
    return notStartedShots.every((f) => f.motionPrompt?.fullPrompt);
  }, [notStartedShots]);

  /**
   * Run one footer action with the shared spinner. Each of these used to
   * `try/finally` without a `catch`, so a rejected generate call reset the
   * button and said nothing — the click read as a hang (#1408). Insufficient
   * credits is the one failure the parent swallows (it opens the billing
   * gate instead), so it never reaches here.
   */
  const runFooterAction = async (
    label: string,
    run: () => Promise<unknown>
  ) => {
    setIsGenerating(true);
    try {
      await run();
    } catch (error) {
      toast.error(label, { description: errorMessage(error) });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || notStartedShots.length === 0) return;
    await runFooterAction('Failed to generate motion', () =>
      onBatchGenerateMotion({
        includeMusic,
        musicModel,
        videoModel,
        generateAudio,
        draftMotion: draftBatch && supportsDraftMode(videoModel),
      })
    );
  };

  const isMotionInProgress = regeneratingMotion.size > 0 || hasGeneratingShots;
  const continueStart =
    nextStage == null
      ? null
      : continueStartFrom(nextStage, {
          generateStartFrames: draftStartFrames,
          generateVoices: voices,
        });
  const showMotionFooter =
    !hideBatchButton &&
    !isMotionInProgress &&
    (nextStage === 'motion' ||
      (nextStage == null && notStartedShots.length > 0));
  const showMusicFooter =
    !hideBatchButton && nextStage === 'music' && Boolean(onGenerateMusic);
  const showContinueFooter =
    !hideBatchButton &&
    isContinueStage(nextStage) &&
    Boolean(onContinueGeneration);
  const continueStopAtClamped =
    nextStage && stageIndex(continueStopAt) < stageIndex(nextStage)
      ? nextStage
      : continueStopAt;
  const ContinueIcon = CONTINUE_ICON[continueStopAtClamped];
  const showButton = showMotionFooter;
  const continueLabelOpts = {
    generateStartFrames: draftStartFrames,
    startFrom: continueStart ?? nextStage ?? undefined,
    remaining: referenceProgress?.remaining,
    total: referenceProgress?.total,
  };

  const handleContinue = async () => {
    if (!onContinueGeneration || !isContinueStage(nextStage)) return;
    const startFrom = isContinueStage(continueStart)
      ? continueStart
      : nextStage;
    await runFooterAction(
      `Failed to ${actionLabelForStage(continueStopAtClamped, {
        ...continueLabelOpts,
        startFrom,
      }).toLowerCase()}`,
      () =>
        onContinueGeneration({
          startFrom,
          stopAt: continueStopAtClamped,
          generateStartFrames: draftStartFrames,
          generateVoices: voices,
        })
    );
  };

  const handleGenerateMusicClick = async () => {
    if (!onGenerateMusic) return;
    await runFooterAction('Failed to generate music', () =>
      onGenerateMusic(musicModel)
    );
  };
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
        resolution:
          draftBatch && supportsDraftMode(videoModel)
            ? DRAFT_RESOLUTION
            : resolution,
        hasReferenceImages: true,
        referenceOnly: rendersReferenceOnly(shot, { generateStartFrames }),
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
  }, [
    draftBatch,
    falPricing,
    notStartedShots,
    includeMusic,
    musicModel,
    videoModel,
    resolution,
    generateStartFrames,
  ]);

  // Approved drafts (#1756): selected, finished, and inside Ark's seven-day
  // window. One final per segment, priced at 1080p.
  const draftSegments = useMemo(
    () =>
      (segments ?? []).filter((segment) => {
        const version = segment.selectedVersion;
        return (
          Boolean(version?.draftTaskId) &&
          version?.status === 'completed' &&
          draftTaskUsable(version.createdAt)
        );
      }),
    [segments]
  );
  const draftFinalCostEstimate = useMemo((): Microdollars | null => {
    if (!falPricing || draftSegments.length === 0) return null;
    let total: Microdollars = ZERO_MICROS;
    let anyHonest = false;
    for (const segment of draftSegments) {
      const stamped = segment.selectedVersion?.model;
      const model =
        stamped && isValidImageToVideoModel(stamped) ? stamped : videoModel;
      const duration = segment.shotIds.reduce(
        (sum, id) =>
          sum +
          resolveShotDuration({
            durationMs: shots?.find((shot) => shot.id === id)?.durationMs,
            model,
          }),
        0
      );
      const perSegment = estimateVideoCost(model, duration, {
        pricing: falPricing,
        resolution: DRAFT_FINAL_RESOLUTION,
        hasReferenceImages: true,
      });
      if (perSegment === null) continue;
      anyHonest = true;
      total = addMicros(total, perSegment);
    }
    return anyHonest ? total : null;
  }, [draftSegments, falPricing, shots, videoModel]);
  const handleRenderDrafts = async () => {
    if (!onRenderDraftsAtQuality) return;
    await runFooterAction('Failed to render at quality', () =>
      onRenderDraftsAtQuality()
    );
  };
  const canRenderDrafts =
    Boolean(onRenderDraftsAtQuality) &&
    !isMotionInProgress &&
    draftSegments.length > 0;
  const renderDraftsButton = canRenderDrafts ? (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        className="w-full"
        onClick={() => void handleRenderDrafts()}
        disabled={isGenerating}
      >
        <Sparkles className="mr-2 h-4 w-4" />
        Render {draftSegments.length}{' '}
        {draftSegments.length === 1 ? 'draft' : 'drafts'} at 1080p
      </Button>
      <ActionCost estimate={draftFinalCostEstimate} />
    </div>
  ) : null;
  const showDraftFooter = !hideBatchButton && !showButton && canRenderDrafts;

  const continueCostEstimate = useGenerationSliceEstimate({
    sequenceId,
    startFrom: continueStart,
    stopAt: continueStopAtClamped,
    generateStartFrames: draftStartFrames,
    generateVoices: voices,
    enabled: showContinueFooter,
  });

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

  // Follow the playhead: bring the playing shot into view when it leaves it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !playingShotId) return;
    const target = selectedListNode(root, playingShotId, undefined);
    if (target) scrollIntoScrollArea(target);
  }, [playingShotId]);

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-background',
        className
      )}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-1">
          {onCollapse && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-2 size-7"
              aria-label="Collapse scenes list"
              title="Collapse scenes list"
              onClick={onCollapse}
            >
              <PanelLeftClose className="size-4" />
            </Button>
          )}
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Scenes
          </h2>
        </div>
        {shots && (
          <TargetDurationChip
            sequenceId={sequenceId}
            totalSeconds={sumShotSeconds(shots)}
            targetDurationSeconds={targetDurationSeconds}
          />
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          onClearSelection();
          if (isWholeSequence) onPlaySequence?.();
        }}
        title={
          isWholeSequence
            ? 'Play the whole sequence'
            : 'Show the whole sequence (Esc zooms out one level at a time)'
        }
        className={cn(
          'flex min-h-11 w-full items-center justify-between gap-2 border-b px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/40 md:min-h-0',
          isWholeSequence && 'bg-primary/5 font-medium text-primary'
        )}
      >
        Whole sequence
        <CirclePlay
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
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

          {groupedScenes.map(({ scene, shots: sceneShots }, index) => (
            <SceneGroup
              key={scene.id}
              scene={scene}
              shots={sceneShots}
              sequenceId={sequenceId}
              segmentsById={segmentsById}
              isSceneSelected={selection.sceneIds.includes(scene.id)}
              selectedShotId={selection.shotId}
              playingShotId={playingShotId}
              aspectRatio={aspectRatio}
              onSelectScene={onSelectScene}
              onSelectShot={onSelectShot}
              onClearSelection={onClearSelection}
              isFirst={index === 0}
              isLast={index === groupedScenes.length - 1}
              onMoveScene={handleMoveScene}
              regeneratingImages={regeneratingImages}
              regeneratingMotion={regeneratingMotion}
              divergentByShotId={divergentByShotId}
              onCompareDivergent={onCompareDivergent}
              staleShotIds={staleShotIds}
              videoModel={videoModel}
              leftoverGrokShotIds={leftoverGrokShotIds}
              onLeftoverGrokChange={onLeftoverGrokChange}
              isAnalyzing={isAnalyzing}
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
                isPlaying={shot.id === playingShotId}
                variant="horizontal"
                isRegeneratingImage={regeneratingImages.has(shot.id)}
                isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                divergentVariantId={divergent?.id}
                onCompareDivergent={
                  divergent ? () => onCompareDivergent?.(divergent) : undefined
                }
                isStale={staleShotIds?.has(shot.id) ?? false}
              />
            );
          })}

          {!loadError && !isLoading && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddScene}
              disabled={!isHydrated || createScene.isPending}
            >
              {createScene.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {createScene.isPending ? 'Adding scene…' : 'Add scene'}
            </Button>
          )}
        </div>
      </ScrollArea>

      {/* Sticky footer with Generate Motion button */}
      {showButton && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          <MotionModelSelector
            selectedModel={videoModel}
            onModelChange={(model) => {
              setVideoModel(model);
              onVideoModelChange?.(model);
            }}
            aspectRatio={aspectRatio}
            styleCategory={styleCategory}
            styleName={styleName}
            disabled={isGenerating || isMotionInProgress}
            // A batch can mix modes, and submit validates the model against
            // every reference-only shot in it — so one such shot is enough to
            // rule out an image-to-video-only model for the whole run.
            referenceOnly={batchRendersReferenceOnly}
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
          {supportsDraftMode(videoModel) && (
            <label
              htmlFor="batch-draft-motion"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Checkbox
                id="batch-draft-motion"
                checked={draftBatch}
                onCheckedChange={(checked) => setDraftBatch(checked === true)}
              />
              <span>Draft at 480p (render at quality once approved)</span>
            </label>
          )}
          {renderDraftsButton}
        </div>
      )}

      {showDraftFooter && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          {renderDraftsButton}
        </div>
      )}

      {showContinueFooter && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          <GenerationStopSlider
            value={continueStopAtClamped}
            onChange={setContinueStopAt}
            minStage={nextStage ?? undefined}
            generateStartFrames={draftStartFrames}
            onGenerateStartFramesChange={setDraftStartFrames}
            generateVoices={voices}
            onGenerateVoicesChange={
              voicesUnavailable ? undefined : setDraftVoices
            }
            disabled={isGenerating}
          />
          <Button
            variant="default"
            className="w-full"
            onClick={() => void handleContinue()}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <ContinueIcon className="mr-2 h-4 w-4" />
                {actionLabelForStage(continueStopAtClamped, continueLabelOpts)}
              </>
            )}
          </Button>
          <ActionCost estimate={continueCostEstimate} />
        </div>
      )}

      {showMusicFooter && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          <MusicModelSelector
            selectedModel={musicModel}
            onModelChange={setMusicModel}
            disabled={isGenerating}
          />
          <Button
            variant="default"
            className="w-full"
            onClick={() => void handleGenerateMusicClick()}
            disabled={isGenerating || !musicPromptsReady}
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : !musicPromptsReady ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Composing music…
              </>
            ) : (
              <>
                <Music className="mr-2 h-4 w-4" />
                Generate Music
              </>
            )}
          </Button>
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
    prevProps.sequenceId !== nextProps.sequenceId ||
    prevProps.selection !== nextProps.selection ||
    prevProps.playingShotId !== nextProps.playingShotId ||
    prevProps.scenes !== nextProps.scenes ||
    prevProps.segments !== nextProps.segments ||
    prevProps.loadError !== nextProps.loadError ||
    prevProps.segmentsError !== nextProps.segmentsError ||
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady ||
    prevProps.hideBatchButton !== nextProps.hideBatchButton ||
    prevProps.nextStage !== nextProps.nextStage ||
    prevProps.generateStartFrames !== nextProps.generateStartFrames ||
    prevProps.generateVoices !== nextProps.generateVoices ||
    prevProps.initialMusicModel !== nextProps.initialMusicModel ||
    prevProps.initialVideoModel !== nextProps.initialVideoModel ||
    prevProps.initialImageModel !== nextProps.initialImageModel ||
    prevProps.styleCategory !== nextProps.styleCategory ||
    prevProps.styleName !== nextProps.styleName ||
    prevProps.staleShotIds !== nextProps.staleShotIds ||
    prevProps.leftoverGrokShotIds !== nextProps.leftoverGrokShotIds ||
    prevProps.referenceProgress?.remaining !==
      nextProps.referenceProgress?.remaining ||
    prevProps.referenceProgress?.total !== nextProps.referenceProgress?.total ||
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
    prevProps.onContinueGeneration !== nextProps.onContinueGeneration ||
    prevProps.onGenerateMusic !== nextProps.onGenerateMusic ||
    prevProps.onCompareDivergent !== nextProps.onCompareDivergent ||
    prevProps.onSelectScene !== nextProps.onSelectScene ||
    prevProps.onSelectShot !== nextProps.onSelectShot ||
    prevProps.onClearSelection !== nextProps.onClearSelection ||
    prevProps.onPlaySequence !== nextProps.onPlaySequence ||
    prevProps.onCollapse !== nextProps.onCollapse ||
    prevProps.onLeftoverGrokChange !== nextProps.onLeftoverGrokChange ||
    prevProps.onVideoModelChange !== nextProps.onVideoModelChange
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
