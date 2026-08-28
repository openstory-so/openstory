import { GenerationProgressBanner } from '@/components/generation/generation-progress-banner';
import { RenderWaitCopy } from '@/components/generation/render-wait-copy';
import { MotionProgressBanner } from '@/components/generation/motion-progress-banner';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { DivergenceCompareDialog } from '@/components/scenes/divergence-compare-dialog';
import { MobileSceneDrawer } from '@/components/scenes/mobile-scene-drawer';
import { CanvasViewToggle } from '@/components/scenes/canvas-view-toggle';
import { CopyScriptButton } from '@/components/scenes/copy-script-button';
import { SceneCanvas } from '@/components/scenes/scene-canvas';
import { SceneScriptDocument } from '@/components/scenes/scene-script-document';
import type { BatchGenerateMotionArgs } from '@/components/scenes/scene-list';
import { SceneList, type SceneListProps } from '@/components/scenes/scene-list';
import { SceneModelBar, scopeLabel } from '@/components/scenes/scene-model-bar';
import {
  SceneScriptPrompts,
  tabsForScope,
  type TabValue,
} from '@/components/scenes/scene-script-prompts';
import { FailureSummaryBanner } from '@/components/sequence/failure-summary-banner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { batchGenerateMotionFn } from '@/functions/motion-functions';
import { getDivergentVariantPromptDiffFn } from '@/functions/prompt-variants';
import { smartRetryFn } from '@/functions/smart-retry';
import { useActiveImageModel } from '@/hooks/use-active-image-model';
import { useActiveVideoModel } from '@/hooks/use-active-video-model';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { useHorizontalSwipe } from '@/hooks/use-horizontal-swipe';
import { useSceneSelection } from '@/hooks/use-scene-selection';
import { useSequenceSegments } from '@/hooks/use-segments';
import { useScenesBySequence, type SceneWithScript } from '@/hooks/use-scenes';
import {
  shotIsStale,
  useSceneShotStaleness,
  useSequenceShotStaleness,
} from '@/hooks/use-shot-staleness';
import { errorMessage, isInsufficientCreditsError } from '@/lib/errors';
import { adjacentShotId } from '@/lib/scenes/shot-walk';
import { sequenceKeys, useSequence } from '@/hooks/use-sequences';
import {
  shotKeys,
  useDiscardVariant,
  useDivergentVariants,
  usePromoteVariantToPrimary,
  useSequenceImageVariants,
  useSequenceSelectedModels,
  useSequenceVideoVariants,
  useShotsBySequence,
  useUndiscardVariant,
} from '@/hooks/use-shots';
import { useSequenceStyle } from '@/hooks/use-styles';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  isValidTextToImageModel,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  clearSelection,
  selectShot,
  selectionScope,
  selectionShots,
  type SceneFacet,
  type ScenesSearch,
} from '@/lib/scenes/scene-selection';
import { formatShotSpan } from '@/lib/scenes/scene-segments';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/lib/ai/resolve-asset-models';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import { isSetImageOffered } from '@/lib/shots/set-image-offer';
import type { FrameVariant, ShotVariant } from '@/lib/db/schema';
import type { ShotView } from '@/lib/shots/shot-view';
import { analyzeLoadedFailures } from '@/lib/failures/failure-analysis';
import type { GenerationPhaseConfig } from '@/lib/realtime/generation-stream.reducer';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { useStaleDetected } from '@/lib/realtime/use-stale-detected';
import type { Sequence } from '@/types/database';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { getSequencesFn } from '@/functions/sequences';
import { captureSequenceReadySeen } from '@/lib/observability/player-events';

import {
  estimateSceneCount,
  estimateTotalSeconds,
} from '@/lib/generation/time-estimate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Minimal coverage row shared by video (`shot_variants`) and image
 * (`frame_variants`, #989) variants. Image variants have no `divergedAt`
 * (divergence is retired for images), so it's optional and treated as never
 * divergent.
 */
type SceneModelVariant = {
  model: string;
  // FrameVariant's wider union (adds 'cancelled', #1085); shot-variant rows
  // assign into it unchanged.
  status: FrameVariant['status'];
  url: string | null;
  discardedAt: Date | null;
  divergedAt?: Date | null;
};

/**
 * Per-model generation status across a scene's shots (#909) — feeds the scene
 * bar's ✓/⟳/! dropdown markers. The model the selected shot currently resolves
 * to (#1066) is marked `set`; completed wins over in-flight/failed.
 * Divergent/discarded alternates ignored.
 */
function buildSceneModelStatuses<V extends SceneModelVariant>(
  variantsByShot: Map<string, V[]>,
  shotIds: ReadonlySet<string>,
  setModel: string
): Map<string, ModelGenerationStatus> {
  const completed = new Set<string>();
  const generating = new Set<string>();
  const failed = new Set<string>();
  for (const shotId of shotIds) {
    for (const v of variantsByShot.get(shotId) ?? []) {
      if ((v.divergedAt ?? null) !== null || v.discardedAt !== null) continue;
      if (v.status === 'completed' && v.url) completed.add(v.model);
      else if (v.status === 'generating' || v.status === 'pending')
        generating.add(v.model);
      else if (v.status === 'failed') failed.add(v.model);
    }
  }
  const map = new Map<string, ModelGenerationStatus>();
  for (const m of failed) map.set(m, 'failed');
  for (const m of generating) map.set(m, 'generating');
  for (const m of completed) map.set(m, 'completed');
  map.set(setModel, 'set');
  return map;
}

type ScenesViewProps = {
  sequenceId: string;
  search?: ScenesSearch;
};

/** Facet tokens ARE tab values (#986); no facet in the URL → default tab. */
function facetToTab(facet?: SceneFacet): TabValue {
  return facet ?? 'cast';
}

const CompareWithPromptDiff: React.FC<{
  sequenceId: string;
  shot: ShotView;
  variant: ShotVariant;
  onClose: () => void;
  onPromote: () => void;
  onDiscard: () => void;
  isPromoting: boolean;
  isDiscarding: boolean;
}> = ({
  sequenceId,
  shot,
  variant,
  onClose,
  onPromote,
  onDiscard,
  isPromoting,
  isDiscarding,
}) => {
  const { data: promptDiff } = useQuery({
    queryKey: ['variant-prompt-diff', sequenceId, variant.id],
    queryFn: () =>
      getDivergentVariantPromptDiffFn({
        data: { sequenceId, variantId: variant.id },
      }),
    staleTime: 30_000,
  });
  return (
    <DivergenceCompareDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      shot={shot}
      variant={variant}
      onPromote={onPromote}
      onDiscard={onDiscard}
      isPromoting={isPromoting}
      isDiscarding={isDiscarding}
      promptDiff={promptDiff ?? undefined}
    />
  );
};

type RegenerationType = 'image' | 'motion' | 'scene-variants';

function addToSet(prev: Set<string>, id: string): Set<string> {
  return new Set(prev).add(id);
}

function removeFromSet(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  next.delete(id);
  return next;
}

function addAllToSet(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of ids) next.add(id);
  return next;
}

function removeAllFromSet(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of ids) next.delete(id);
  return next;
}

function isTerminalStatus(status: string | null): boolean {
  // 'cancelled' (#1108): a user cancel is terminal — it must clear the
  // regenerating spinner like completed/failed do.
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

export const ScenesView: React.FC<ScenesViewProps> = ({
  sequenceId,
  search = {},
}) => {
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  const { showGate: showBillingGate } = useFalBillingGate();

  const {
    selection,
    setSelection,
    handleSelectScene,
    handleFocusScene,
    handleSelectShot,
    handleClearSelection,
    handleAscendSelection,
    setFacet,
    view,
    setView,
  } = useSceneSelection({ search, sequenceId });

  const [selectedTab, setSelectedTab] = useState<TabValue>(() =>
    facetToTab(search.facet)
  );

  useEffect(() => {
    if (search.facet) {
      setSelectedTab(facetToTab(search.facet));
    }
  }, [search.facet]);

  const [regeneratingImages, setRegeneratingImages] = useState<Set<string>>(
    () => new Set()
  );
  const [regeneratingMotion, setRegeneratingMotion] = useState<Set<string>>(
    () => new Set()
  );
  const [regeneratingSceneVariants, setRegeneratingSceneVariants] = useState<
    Set<string>
  >(() => new Set());

  // Poll sequence while a motion batch is in flight so per-shot statuses stay
  // fresh. The refetchInterval fn reads from the query cache each tick to
  // avoid a circular dependency between sequence state and the poll condition.
  const { data: sequence } = useSequence(sequenceId, {
    refetchInterval: (query) => {
      const seq = query.state.data;
      if (!seq) return false;
      const cachedShots = queryClient.getQueryData<ShotView[]>(
        shotKeys.list(sequenceId)
      );
      return cachedShots?.some((f) => f.videoStatus === 'generating')
        ? 2000
        : false;
    },
  });
  const aspectRatio = sequence?.aspectRatio || DEFAULT_ASPECT_RATIO;
  const isProcessing = sequence?.status === 'processing';
  const processingRef = useRef(isProcessing);
  processingRef.current = isProcessing;
  const leftCapturedRef = useRef(false);
  // Assigned after `remainingSeconds` is computed below; read at leave time.
  const remainingRef = useRef(0);
  const router = useRouter();

  useEffect(() => {
    leftCapturedRef.current = false;
  }, [sequenceId]);

  useEffect(() => {
    const captureLeave = (destination: string) => {
      if (!processingRef.current || leftCapturedRef.current) return;
      leftCapturedRef.current = true;
      posthog.capture('render_wait_left', {
        sequence_id: sequenceId,
        seconds_remaining_estimate: remainingRef.current,
        destination,
      });
    };
    const onPageHide = () => captureLeave('unload');
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // On unmount the router already points at where the user went.
      captureLeave(router.latestLocation.pathname);
    };
  }, [sequenceId, posthog, router]);

  // First sight of the finished video (#1301): the funnel step between
  // sequence_generated and video_play. Once per sequence per mount.
  const readySeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (sequence?.status !== 'completed' || readySeenRef.current === sequenceId)
      return;
    readySeenRef.current = sequenceId;
    const createdAt = new Date(sequence.createdAt).getTime();
    void queryClient
      .fetchQuery({
        queryKey: sequenceKeys.list(undefined),
        queryFn: () => getSequencesFn(),
        staleTime: 5 * 60 * 1000,
      })
      .then((list) => {
        captureSequenceReadySeen(posthog, {
          sequence_id: sequenceId,
          first_sequence_for_team: list.every(
            (s) =>
              s.id === sequenceId ||
              new Date(s.createdAt).getTime() >= createdAt
          ),
          seconds_since_generate: Math.round((Date.now() - createdAt) / 1000),
        });
      })
      .catch(() => {
        // Analytics only — never surface.
      });
  }, [sequence?.status, sequence?.createdAt, sequenceId, queryClient, posthog]);
  const { data: style } = useSequenceStyle(sequenceId);
  const styleCategory = style?.category ?? undefined;
  const sequenceMusicModel = safeAudioModel(
    sequence?.musicModel,
    DEFAULT_MUSIC_MODEL
  );
  const sequenceVideoModel = safeImageToVideoModel(
    sequence?.videoModel,
    DEFAULT_VIDEO_MODEL
  );
  const styleName = style?.name ?? undefined;
  const recommendedImageModel = style?.recommendedImageModel ?? null;
  const recommendedVideoModel = style?.recommendedVideoModel ?? null;

  // Phase config from DB — set in stone when the workflow was triggered
  const phaseConfig = useMemo<GenerationPhaseConfig>(
    () => ({
      autoGenerateMotion: sequence?.autoGenerateMotion ?? false,
      autoGenerateMusic: sequence?.autoGenerateMusic ?? false,
    }),
    [sequence?.autoGenerateMotion, sequence?.autoGenerateMusic]
  );

  // Subscribe to real-time generation events when sequence is processing.
  // Skip history replay for non-processing sequences to avoid a brief flash of
  // the progress banner on tab re-mount caused by replaying old phase events.
  const {
    state: generationState,
    status: realtimeStatus,
    reset: resetGenerationStream,
  } = useGenerationStream(sequenceId, phaseConfig, {
    replayHistory: isProcessing,
  });

  // Hybrid polling: only poll when processing AND realtime has failed
  // - 'connecting' → wait for connection, don't poll
  // - 'connected' → use realtime, don't poll
  // - 'disconnected'/'error' → poll as fallback
  const realtimeFailed = realtimeStatus === 'error';
  const shouldPoll = isProcessing && realtimeFailed;

  // Fetch shots — only poll when processing AND realtime has failed.
  // Otherwise realtime events keep the cache fresh via updateQueryCacheFromEvent.
  const { data: shots, error: shotsError } = useShotsBySequence(
    sequenceId,
    shouldPoll ? { refetchInterval: 2000 } : undefined
  );

  const handleWalkShot = useCallback(
    (delta: -1 | 1) => {
      const next = adjacentShotId(shots ?? [], selection, delta);
      if (!next) return;
      if (next.type === 'sequence') {
        setSelection(clearSelection(), undefined, true);
        return;
      }
      setSelection(selectShot(next.id), undefined, true);
    },
    [shots, selection, setSelection]
  );

  // Progressive reveal (#1091): while the script is being split the canvas has
  // nothing to show, so the Script view is forced and the Canvas toggle stays
  // disabled. When the first shot preview lands the override drops away and —
  // unless the user explicitly chose the script view (URL `view=script`) —
  // the derived view falls back to the canvas default, auto-revealing the
  // first images as they arrive. No effect, no state: pure derivation.
  const canvasReady =
    !isProcessing ||
    (shots?.some((s) => s.image?.url || s.previewThumbnailUrl) ?? false);
  const effectiveView = canvasReady ? view : 'script';
  const canvasSwipe = useHorizontalSwipe(
    effectiveView === 'canvas' ? handleWalkShot : undefined
  );

  // Escape progressive zoom-out (#986):
  // 1) blur the focused editing field (exit typing)
  // 2) else yield to an open dialog/menu/popover
  // 3) else walk selection up a level: shot → scene → sequence
  // Capture phase so we still see the key when a focused control stops bubbling.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return;

      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        const isEditingField =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable;

        if (isEditingField) {
          // Leave the field first; a second Esc ascends selection.
          e.preventDefault();
          e.stopPropagation();
          target.blur();
          return;
        }

        // Only yield to overlays that are currently open — a closed dialog
        // still in the tree (or a focused control inside a non-modal panel)
        // must not swallow Esc.
        if (
          target.closest(
            [
              '[role="dialog"][data-state="open"]',
              '[role="alertdialog"][data-state="open"]',
              '[role="menu"][data-state="open"]',
              '[role="listbox"][data-state="open"]',
              '[data-radix-popper-content-wrapper] [data-state="open"]',
              '[data-state="open"][role="combobox"]',
            ].join(', ')
          )
        ) {
          return;
        }
      }

      if (
        document.querySelector(
          [
            '[role="dialog"][data-state="open"]',
            '[role="alertdialog"][data-state="open"]',
            '[data-slot="dialog-content"][data-state="open"]',
            '[data-slot="sheet-content"][data-state="open"]',
          ].join(', ')
        )
      ) {
        return;
      }

      if (handleAscendSelection(shots ?? [])) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleAscendSelection, shots]);

  // Fetch image variants for this sequence (frame_variants kind:'model', #989)
  const { data: imageVariants } = useSequenceImageVariants(sequenceId);

  // Video variants + viewer-local active video model (#545). When the viewer
  // pins a model in the header dropdown, the player resolves every shot's
  // video through that model's variant; "Mixed" (null) keeps each shot's own
  // (legacy) video.
  const { data: videoVariants } = useSequenceVideoVariants(sequenceId);
  const { activeVideoModel } = useActiveVideoModel(sequenceId);

  // Render segments (#986/#990) — group the shot strip into per-video segments
  // and drive the segment-aware Video tab. Poll while motion is in flight so a
  // freshly-rendered segment's version + staleness land without a manual reload.
  const anyVideoGenerating = useMemo(
    () => shots?.some((f) => f.videoStatus === 'generating') ?? false,
    [shots]
  );
  const { data: segments, error: segmentsError } = useSequenceSegments(
    sequenceId,
    anyVideoGenerating ? { refetchInterval: 2000 } : undefined
  );

  const videoVariantsByShot = useMemo(() => {
    const map = new Map<string, ShotVariant[]>();
    if (!videoVariants) return map;
    for (const v of videoVariants) {
      if (v.variantType !== 'video') continue;
      const list = map.get(v.shotId) ?? [];
      list.push(v);
      map.set(v.shotId, list);
    }
    return map;
  }, [videoVariants]);

  // Viewer-local active image model (#547). When pinned, the player shows that
  // model's image for each shot (falling back to the legacy thumbnail when the
  // model has no completed image for a shot).
  const { activeImageModel } = useActiveImageModel(sequenceId);
  // Image variants are frame_variants now; each carries its owning `shotId`
  // (frame ids ≠ shot ids, #989), so key the map by shot id. The query already
  // returns only kind:'model', non-discarded rows.
  const imageVariantsByShot = useMemo(() => {
    const map = new Map<string, FrameVariant[]>();
    if (!imageVariants) return map;
    for (const v of imageVariants) {
      const list = map.get(v.shotId) ?? [];
      list.push(v);
      map.set(v.shotId, list);
    }
    return map;
  }, [imageVariants]);

  // Scenes the pinned image model has NOT generated yet (#547). When a model is
  // pinned, the player + scene list flag these so a viewer isn't shown the
  // primary image as if it were the pinned model's output.
  const activeImageModelLabel =
    activeImageModel && isValidTextToImageModel(activeImageModel)
      ? IMAGE_MODELS[activeImageModel].name
      : null;
  const shotsMissingActiveImage = useMemo(() => {
    const missing = new Set<string>();
    if (!activeImageModel || !shots) return missing;
    for (const f of shots) {
      const hasModel = imageVariantsByShot
        .get(f.id)
        ?.some(
          (v) =>
            v.model === activeImageModel &&
            v.discardedAt === null &&
            v.status === 'completed' &&
            v.url
        );
      if (!hasModel) missing.add(f.id);
    }
    return missing;
  }, [activeImageModel, shots, imageVariantsByShot]);

  // Divergent alternates + realtime stale:detected wiring (issue #625).
  // Mirror the shots-list polling fallback so the corner-dot still updates
  // when realtime is down.
  const { data: divergentVariants } = useDivergentVariants(
    sequenceId,
    shouldPoll ? { refetchInterval: 2000 } : undefined
  );
  useStaleDetected(sequenceId);
  const promoteVariant = usePromoteVariantToPrimary();
  const discardVariant = useDiscardVariant();
  const undiscardVariant = useUndiscardVariant();
  const [compareVariant, setCompareVariant] = useState<ShotVariant | null>(
    null
  );

  const handleDiscardWithUndo = useCallback(
    (variant: ShotVariant) => {
      const restore = () => {
        undiscardVariant.mutate(
          {
            sequenceId,
            shotId: variant.shotId,
            variantId: variant.id,
          },
          {
            onError: (error) => {
              toast.error('Failed to restore alternate', {
                description: errorMessage(error),
              });
            },
          }
        );
      };
      discardVariant.mutate(
        { sequenceId, shotId: variant.shotId, variantId: variant.id },
        {
          onSuccess: () => {
            // Only close the dialog after the mutation succeeds — on failure
            // the user keeps the dialog open and can retry from there.
            setCompareVariant(null);
            toast('Alternate discarded', {
              action: { label: 'Undo', onClick: restore },
            });
          },
          onError: (error) => {
            toast.error('Failed to discard alternate', {
              description: errorMessage(error),
            });
          },
        }
      );
    },
    [sequenceId, discardVariant, undiscardVariant]
  );

  // If the shot backing the open compare dialog disappears (e.g. concurrent
  // delete from another tab), close the dialog explicitly with a toast rather
  // than silently null-rendering it.
  useEffect(() => {
    if (!compareVariant || !shots) return;
    const stillExists = shots.some((f) => f.id === compareVariant.shotId);
    if (!stillExists) {
      toast.info('Scene was removed.');
      setCompareVariant(null);
    }
  }, [compareVariant, shots]);

  const handlePromote = useCallback(
    (variant: ShotVariant) => {
      promoteVariant.mutate(
        { sequenceId, shotId: variant.shotId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast.success('Alternate promoted');
          },
          onError: (error) => {
            toast.error('Failed to promote alternate', {
              description: errorMessage(error),
            });
          },
        }
      );
    },
    [sequenceId, promoteVariant]
  );

  const curSelectedShotId = selection.shotId;
  const selectedShot = useMemo(
    () =>
      curSelectedShotId
        ? shots?.find((shot) => shot.id === curSelectedShotId)
        : undefined,
    [shots, curSelectedShotId]
  );

  const scope = selectionScope(selection);

  // The render segment (#986) the selected shot belongs to, plus a span label
  // built from the covered shots' 1-based numbers — feeds the Video tab's
  // segment panel. Undefined until the shot is rendered into a segment.
  const selectedSegment = useMemo(
    () =>
      curSelectedShotId
        ? segments?.find((s) => s.shotIds.includes(curSelectedShotId))
        : undefined,
    [segments, curSelectedShotId]
  );
  const selectedSegmentSpanLabel = useMemo(() => {
    if (!selectedSegment || !shots) return undefined;
    const numberById = new Map(shots.map((f) => [f.id, f.shotNumber]));
    const numbers = selectedSegment.shotIds
      .map((id) => numberById.get(id))
      .filter((n): n is number => n != null);
    return formatShotSpan(numbers);
  }, [selectedSegment, shots]);

  // Tabs are level-aware (#986). `selectedTab` holds the user's last pick; when
  // the scope changes so that pick is no longer offered, fall back to the first
  // tab for the new scope without mutating state — every downstream consumer
  // reads `effectiveTab` so the panel, canvas, and previews stay in agreement.
  const visibleTabs = useMemo(() => tabsForScope(scope), [scope]);
  const effectiveTab = useMemo(
    () =>
      visibleTabs.some((t) => t.value === selectedTab)
        ? selectedTab
        : (visibleTabs[0]?.value ?? 'cast'),
    [visibleTabs, selectedTab]
  );

  // Shot ids in scope; `null` = whole sequence, so facets show the full
  // library. Facet MEMBERSHIP is resolved server-side (see use-scene-facets) —
  // this only says which shots are selected.
  const facetShotIds = useMemo(() => {
    if (scope === 'sequence') return null;
    return (shots ? selectionShots(selection, shots) : []).map((s) => s.id);
  }, [scope, selection, shots]);

  // Scenes group the shots; they carry no model of their own (#1066) — model
  // identity lives on the selected frame_variants / video_variants row.
  const { data: scenes, error: scenesError } = useScenesBySequence(sequenceId);
  const scenesById = useMemo(() => {
    const map = new Map<string, SceneWithScript>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);
  // At shot scope the selection is that shot's own scene; at scene scope it can
  // be several (#986).
  const selectedScenes = useMemo(() => {
    if (scope === 'shot' && selectedShot?.sceneId) {
      const scene = scenesById.get(selectedShot.sceneId);
      return scene ? [scene] : [];
    }
    if (scope === 'scenes') {
      return selection.sceneIds
        .map((id) => scenesById.get(id))
        .filter((s): s is SceneWithScript => s != null);
    }
    return [];
  }, [scope, selectedShot, selection.sceneIds, scenesById]);

  // The scene the Script facet targets: exactly one, or none. At shot scope
  // that's the shot's own scene; at scene scope the single selected scene. A
  // multi-scene selection leaves it undefined so the facet reads rather than
  // silently writing to whichever scene happened to be first.
  const scriptScene =
    selectedScenes.length === 1 ? selectedScenes[0] : undefined;

  // Scene batch feeds the in-focus summary; sequence batch feeds the left
  // rail so unselected shots (including other scenes) still get amber dots.
  const { data: sceneStaleness, isError: sceneStalenessFailed } =
    useSceneShotStaleness({
      sequenceId,
      sceneId: scriptScene?.id,
    });
  const { data: sequenceStaleness, isError: sequenceStalenessFailed } =
    useSequenceShotStaleness({ sequenceId });
  const scriptSceneShots = useMemo(
    () =>
      scriptScene && shots
        ? shots.filter((s) => s.sceneId === scriptScene.id)
        : undefined,
    [scriptScene, shots]
  );
  const scopeStaleness =
    scope === 'sequence' ? sequenceStaleness : sceneStaleness;
  // A failed staleness check must not render as "everything is up to date":
  // with no data every downstream consumer draws a confidently clean UI (no
  // dots, no chips, no summary) off the back of a request that errored.
  const scopeStalenessFailed =
    scope === 'sequence' ? sequenceStalenessFailed : sceneStalenessFailed;
  const scopeShots = scope === 'sequence' ? shots : scriptSceneShots;
  const staleShotIds = useMemo(() => {
    const set = new Set<string>();
    // Sequence-wide first so every rail thumbnail can show a dot; the
    // in-focus scene batch overwrites the same keys when it arrives.
    const merged = { ...sequenceStaleness, ...sceneStaleness };
    for (const [shotId, staleness] of Object.entries(merged)) {
      if (shotIsStale(staleness)) set.add(shotId);
    }
    return set;
  }, [sequenceStaleness, sceneStaleness]);

  // Model identity lives on the version that produced the asset (#1066), so the
  // tabs target whatever the selected shot's selected image/video version was
  // rendered with. A pick in the dropdown is a per-request override for the
  // NEXT generation — it becomes durable once that version is selected, so it's
  // held in view state rather than written anywhere.
  //
  // A pick therefore has to EXPIRE, or it outranks fresher server truth forever
  // (it sits at the `explicit` tier, above everything). It carries the model it
  // was made against, and stops applying as soon as that changes — which covers
  // the pick's own generation completing, a "Set", a sequence-wide Set, and a
  // teammate's change alike. Derived during render, so no effect syncs state.
  // A FAILED generation doesn't move the selection, so the pick survives for a
  // retry, which is the behaviour you want.
  const { data: selectedModels } = useSequenceSelectedModels(sequenceId);
  const [imageModelPick, setImageModelPick] = useState<{
    shotId: string;
    model: TextToImageModel;
    basedOn: string | null;
  } | null>(null);
  const [videoModelPick, setVideoModelPick] = useState<{
    shotId: string;
    model: ImageToVideoModel;
    basedOn: string | null;
  } | null>(null);

  const selectedImageModelForShot = curSelectedShotId
    ? (selectedModels?.imageModelByShot[curSelectedShotId] ?? null)
    : null;
  const selectedVideoModelForShot = curSelectedShotId
    ? (selectedModels?.videoModelByShot[curSelectedShotId] ?? null)
    : null;

  // A pick applies only to its own shot, and only while the model it was made
  // against still stands.
  const activeImagePick =
    imageModelPick &&
    imageModelPick.shotId === curSelectedShotId &&
    imageModelPick.basedOn === selectedImageModelForShot
      ? imageModelPick.model
      : null;
  const activeVideoPick =
    videoModelPick &&
    videoModelPick.shotId === curSelectedShotId &&
    videoModelPick.basedOn === selectedVideoModelForShot
      ? videoModelPick.model
      : null;

  const resolvedImageModel = resolveImageModel({
    explicit: activeImagePick,
    // Show the model a retry would actually run for a failed shot, so the
    // dropdown and the server agree (#1066).
    lastFailedAttemptModel: curSelectedShotId
      ? selectedModels?.failedImageModelByShot[curSelectedShotId]
      : null,
    selectedVersionModel: selectedImageModelForShot,
    sequenceModel: sequence?.imageModel,
  });
  const resolvedVideoModel = resolveVideoModel({
    explicit: activeVideoPick,
    lastFailedAttemptModel: curSelectedShotId
      ? selectedModels?.failedVideoModelByShot[curSelectedShotId]
      : null,
    selectedVersionModel: selectedVideoModelForShot,
    sequenceModel: sequence?.videoModel,
  });

  // Per-model coverage for the selected scene's shots — feeds the scene bar's
  // Look/Motion dropdown markers (which models have generated, and how many).
  const sceneShotIds = useMemo(() => {
    const set = new Set<string>();
    if (!shots) return set;
    const targetSceneIds = new Set(selectedScenes.map((s) => s.id as string));
    if (targetSceneIds.size === 0) {
      if (scope === 'sequence') {
        for (const s of shots) set.add(s.id);
      }
      return set;
    }
    for (const s of shots) {
      if (s.sceneId && targetSceneIds.has(s.sceneId)) set.add(s.id);
    }
    return set;
  }, [selectedScenes, shots, scope]);
  const sceneImageModelStatuses = useMemo(
    () =>
      buildSceneModelStatuses(
        imageVariantsByShot,
        sceneShotIds,
        resolvedImageModel
      ),
    [imageVariantsByShot, sceneShotIds, resolvedImageModel]
  );
  const sceneVideoModelStatuses = useMemo(
    () =>
      buildSceneModelStatuses(
        videoVariantsByShot,
        sceneShotIds,
        resolvedVideoModel
      ),
    [videoVariantsByShot, sceneShotIds, resolvedVideoModel]
  );

  const handleImageModelChange = useCallback(
    (model: TextToImageModel) => {
      if (!curSelectedShotId) return;
      setImageModelPick({
        shotId: curSelectedShotId,
        model,
        basedOn: selectedImageModelForShot,
      });
    },
    [curSelectedShotId, selectedImageModelForShot]
  );
  const handleVideoModelChange = useCallback(
    (model: ImageToVideoModel) => {
      if (!curSelectedShotId) return;
      setVideoModelPick({
        shotId: curSelectedShotId,
        model,
        basedOn: selectedVideoModelForShot,
      });
    },
    [curSelectedShotId, selectedVideoModelForShot]
  );

  const resolvedSequenceImageModel = safeTextToImageModel(
    sequence?.imageModel,
    DEFAULT_IMAGE_MODEL
  );
  const resolvedSequenceVideoModel = safeImageToVideoModel(
    sequence?.videoModel,
    DEFAULT_VIDEO_MODEL
  );

  // In-flight retry state (#882) for the selected shot. Image retry matters
  // before the thumbnail exists; video retry after — the image entry is cleared
  // once it completes, so preferring it is correct in both stages.
  const selectedShotRetry = useMemo(() => {
    if (!curSelectedShotId) return undefined;
    const r = generationState.shotRetries.get(curSelectedShotId);
    return r?.image ?? r?.video;
  }, [generationState.shotRetries, curSelectedShotId]);

  // Filter variants for the currently selected shot (by owning shotId — frame
  // ids ≠ shot ids, #989).
  const selectedShotVariants = useMemo(() => {
    if (!imageVariants || !curSelectedShotId) return undefined;
    return imageVariants.filter((v) => v.shotId === curSelectedShotId);
  }, [imageVariants, curSelectedShotId]);

  // The image-prompt tab targets the shot's resolved look model (#1066); its
  // variant + Set/Generate state track that model. The header pin (#547) stays
  // a viewer-local *display* concern, handled in the player remap below.
  const effectiveImageModel = resolvedImageModel;

  // Newest-first match for the tab model. `.find` on oldest-first order used to
  // return the EARLIEST version, so "Set Image" appeared whenever the latest
  // (selected) still didn't match v1's url — the opposite of what setImage
  // actually applies (latest completed). Prefer an in-flight row so Regenerate
  // shows Generating… mid-roll; else the latest completed (matches
  // `setImageFromVariantFn`).
  const variantForSelectedModel = useMemo(() => {
    if (!selectedShotVariants) return undefined;
    const forModel = selectedShotVariants.filter(
      (v) => v.model === effectiveImageModel
    );
    if (forModel.length === 0) return undefined;
    const newestFirst = [...forModel].reverse();
    return (
      newestFirst.find((v) => v.status === 'generating') ??
      newestFirst.find((v) => v.status === 'completed' && v.url) ??
      newestFirst[0]
    );
  }, [selectedShotVariants, effectiveImageModel]);

  // Motion mirror: the shot's resolved video model (#1066) drives the
  // motion-prompt tab's variant + Set/Generate state. Excludes divergent /
  // discarded alternates so only the primary per-model row is matched.
  const effectiveVideoModel = resolvedVideoModel;

  const videoVariantForSelectedModel = useMemo(() => {
    if (!curSelectedShotId) return undefined;
    return videoVariantsByShot
      .get(curSelectedShotId)
      ?.find(
        (v) =>
          v.model === effectiveVideoModel &&
          v.divergedAt === null &&
          v.discardedAt === null
      );
  }, [videoVariantsByShot, curSelectedShotId, effectiveVideoModel]);

  // Canvas badges for the image/motion tabs. The model dropdown is a pick for
  // the *next* generation (#1066) — do NOT swap the canvas to another model's
  // still/clip while browsing models. That showed non-current media (and often
  // looked like the wrong model) and fought the "applies to the next
  // generation" copy. Set Image / Set Video in the inspector still repoint
  // selection when the user opts in.
  const { previewVariantUrl, previewVariantVideoUrl, playerBadgeMessage } =
    useMemo(() => {
      const none = {
        previewVariantUrl: null as string | null,
        previewVariantVideoUrl: null as string | null,
        playerBadgeMessage: null as string | null,
      };
      if (!selectedShot) return none;

      if (effectiveTab === 'image-prompt') {
        const currentImageModel = safeTextToImageModel(
          selectedShot.image?.model,
          DEFAULT_IMAGE_MODEL
        );
        // Same rule as the inspector Set Image button: only when the dropdown
        // model is not the one that produced the current primary still.
        // Uploads are already current — don't ask to Set Image (that would
        // revert to an older generation).
        if (
          isSetImageOffered({
            variantCompleted:
              variantForSelectedModel?.status === 'completed' &&
              !!variantForSelectedModel.url,
            currentImageUrl: selectedShot.image?.url,
            currentKind: selectedShot.image?.kind,
            currentModel: selectedShot.image?.model,
            dropdownModel: effectiveImageModel,
          })
        ) {
          return {
            ...none,
            playerBadgeMessage: 'Click Set Image to use this model',
          };
        }
        if (
          effectiveImageModel !== currentImageModel &&
          !variantForSelectedModel
        ) {
          return {
            ...none,
            playerBadgeMessage: 'Click Generate Image to create',
          };
        }
        return none;
      }

      if (effectiveTab === 'motion-prompt') {
        const currentVideoModel = safeImageToVideoModel(
          selectedShot.video?.model,
          DEFAULT_VIDEO_MODEL
        );
        if (
          videoVariantForSelectedModel?.status === 'completed' &&
          videoVariantForSelectedModel.url &&
          effectiveVideoModel !== currentVideoModel
        ) {
          return {
            ...none,
            playerBadgeMessage: 'Click Set Video to use this model',
          };
        }
        if (
          effectiveVideoModel !== currentVideoModel &&
          !videoVariantForSelectedModel
        ) {
          return {
            ...none,
            playerBadgeMessage: 'Click Generate Motion to create',
          };
        }
        return none;
      }

      return none;
    }, [
      effectiveTab,
      selectedShot,
      effectiveImageModel,
      variantForSelectedModel,
      effectiveVideoModel,
      videoVariantForSelectedModel,
    ]);

  // Shots as shown by the player: when an image and/or video model is pinned,
  // swap each shot's image / video for that model's variant. Only the player
  // display is remapped — every other consumer keeps the raw `shots`
  // (generation status, selection, the per-shot preview overlay, etc.).
  const playerShots = useMemo(() => {
    if (!shots) return shots;
    // Wait for the relevant variants query before remapping, so we don't blank
    // a pinned type while its data is still loading. The image pin is suppressed
    // on the image-prompt tab, where the per-shot preview overlay + prompt
    // panel govern the displayed image (avoids desyncing them from the header).
    const pinImage =
      activeImageModel && imageVariants && effectiveTab !== 'image-prompt';
    const pinVideo = activeVideoModel && videoVariants;
    if (!pinImage && !pinVideo) return shots;
    return shots.map((f) => {
      let next = f;
      if (pinImage) {
        // Image: swap the displayed image; fall back to the legacy thumbnail
        // when the pinned model has no completed image for this shot (never
        // leave a shot imageless).
        const iv = imageVariantsByShot
          .get(f.id)
          ?.find(
            (v) =>
              v.model === activeImageModel &&
              v.discardedAt === null &&
              v.status === 'completed' &&
              v.url
          );
        if (iv?.url) next = { ...next, image: iv };
      }
      if (pinVideo) {
        // Video: show only the pinned model's output (no fallback — a missing
        // variant means that model hasn't produced this shot yet).
        const vv = videoVariantsByShot
          .get(f.id)
          ?.find(
            (v) =>
              v.model === activeVideoModel &&
              v.divergedAt === null &&
              v.discardedAt === null
          );
        next = vv
          ? {
              ...next,
              // The pinned model's clip rides on the shot's own version row —
              // `shot_variants` is a different table, so there is no
              // `video_variants` row to point at.
              video:
                vv.status === 'completed' && next.video
                  ? { ...next.video, url: vv.url, model: vv.model }
                  : null,
              videoStatus: vv.status,
            }
          : { ...next, video: null, videoStatus: 'pending' as const };
      }
      return next;
    });
  }, [
    shots,
    effectiveTab,
    activeImageModel,
    imageVariants,
    imageVariantsByShot,
    activeVideoModel,
    videoVariants,
    videoVariantsByShot,
  ]);

  const setterForType = useCallback((type: RegenerationType) => {
    switch (type) {
      case 'image':
        return setRegeneratingImages;
      case 'motion':
        return setRegeneratingMotion;
      case 'scene-variants':
        return setRegeneratingSceneVariants;
    }
  }, []);

  const handleRegenerateStart = useCallback(
    (shotId: string, type: RegenerationType) => {
      setterForType(type)((prev) => addToSet(prev, shotId));
    },
    [setterForType]
  );

  const handleRegenerateEnd = useCallback(
    (shotId: string, type: RegenerationType) => {
      setterForType(type)((prev) => removeFromSet(prev, shotId));
    },
    [setterForType]
  );

  // Auto-remove shots from regenerating sets when generation completes or fails
  useEffect(() => {
    if (!shots) return;

    for (const shot of shots) {
      if (
        regeneratingImages.has(shot.id) &&
        isTerminalStatus(shot.frame.imageStatus)
      )
        handleRegenerateEnd(shot.id, 'image');
      if (regeneratingMotion.has(shot.id) && isTerminalStatus(shot.videoStatus))
        handleRegenerateEnd(shot.id, 'motion');
      if (
        regeneratingSceneVariants.has(shot.id) &&
        isTerminalStatus(shot.gridSheet?.status ?? null)
      )
        handleRegenerateEnd(shot.id, 'scene-variants');
    }
  }, [
    shots,
    regeneratingImages,
    regeneratingMotion,
    regeneratingSceneVariants,
    handleRegenerateEnd,
  ]);

  // Derive motion banner state from query data so it persists naturally across
  // tab switches — no local state needed. startedAt uses the earliest
  // generating shot's updatedAt so elapsed time stays accurate.
  const motionBannerState = useMemo(() => {
    if (!shots || !sequence) return null;
    const anyGenerating = shots.some((f) => f.videoStatus === 'generating');
    if (!anyGenerating) return null;
    const generatingTimes = shots
      .filter((f) => f.videoStatus === 'generating')
      .map((f) => f.updatedAt.getTime());
    const startedAt =
      generatingTimes.length > 0 ? Math.min(...generatingTimes) : Date.now();
    return {
      startedAt,
      includeMusic: sequence.musicStatus === 'generating',
    };
  }, [shots, sequence]);

  const [isRetrying, setIsRetrying] = useState(false);

  // Mobile inspector starts collapsed so the canvas keeps the vertical space.
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);

  const failureSummary = useMemo(
    () => analyzeLoadedFailures(shots, sequence, scenesById),
    [shots, sequence, scenesById]
  );

  const handleSmartRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      const result = await smartRetryFn({ data: { sequenceId } });
      toast.success(
        result.retryType === 'full'
          ? 'Continuing generation'
          : `Retrying: ${result.retriedItems.join(', ')}`
      );
      void queryClient.invalidateQueries({
        queryKey: ['sequence', sequenceId],
      });
      void queryClient.invalidateQueries({ queryKey: ['shots', sequenceId] });
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showBillingGate('insufficient');
        void queryClient.invalidateQueries({
          queryKey: BILLING_BALANCE_KEY,
        });
      } else {
        toast.error('Failed to retry', {
          description: errorMessage(error),
        });
      }
    } finally {
      setIsRetrying(false);
    }
  }, [sequenceId, queryClient, showBillingGate]);

  // Handler for batch motion generation (server determines eligible shots)
  const handleBatchMotionGeneration = useCallback(
    async ({
      includeMusic,
      musicModel,
      videoModel,
      generateAudio,
    }: BatchGenerateMotionArgs) => {
      // Optimistic: compute eligible shots locally (same filter as backend).
      // 'cancelled' is user-initiated (#1108 Phase 4): deliberately eligible
      // for a user-driven batch generate, never auto-retried.
      const eligibleShotIds = (shots ?? [])
        .filter(
          (f) =>
            f.frame.imageStatus === 'completed' &&
            (f.videoStatus === 'pending' ||
              f.videoStatus === 'failed' ||
              f.videoStatus === 'cancelled')
        )
        .map((f) => f.id);

      setRegeneratingMotion((prev) => addAllToSet(prev, eligibleShotIds));

      // Optimistically mark shots as generating in the query cache so the
      // derived banner state shows the banner immediately — no separate state.
      const eligibleSet = new Set(eligibleShotIds);
      const now = new Date();
      queryClient.setQueryData<ShotView[]>(shotKeys.list(sequenceId), (old) =>
        old?.map((f) =>
          eligibleSet.has(f.id)
            ? { ...f, videoStatus: 'generating', updatedAt: now }
            : f
        )
      );
      if (includeMusic) {
        queryClient.setQueryData<Sequence>(
          sequenceKeys.detail(sequenceId),
          (old) => (old ? { ...old, musicStatus: 'generating' } : old)
        );
      }

      posthog.capture('motion_generation_started', {
        sequence_id: sequenceId,
        include_music: includeMusic,
        eligible_shot_count: eligibleShotIds.length,
        // Explicit batch model overrides per-shot identity (#1066).
        video_model: videoModel,
        music_model: includeMusic ? musicModel : undefined,
        generate_audio: generateAudio,
      });

      try {
        await batchGenerateMotionFn({
          data: {
            sequenceId,
            includeMusic,
            model: videoModel,
            musicModel: includeMusic ? musicModel : undefined,
            generateAudio,
          },
        });
        // Server may have updated sequence.videoModel / sequence.musicModel to
        // the batch picks; invalidate so the header badge, footer pre-fill,
        // and per-shot fallback all reflect the new values.
        void queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        });
      } catch (error) {
        setRegeneratingMotion((prev) =>
          removeAllFromSet(prev, eligibleShotIds)
        );
        // Roll back optimistic cache updates
        queryClient.setQueryData<ShotView[]>(shotKeys.list(sequenceId), (old) =>
          old?.map((f) =>
            eligibleSet.has(f.id) ? { ...f, videoStatus: 'pending' } : f
          )
        );
        if (includeMusic) {
          void queryClient.invalidateQueries({
            queryKey: sequenceKeys.detail(sequenceId),
          });
        }

        if (isInsufficientCreditsError(error)) {
          showBillingGate('insufficient');
          void queryClient.invalidateQueries({
            queryKey: BILLING_BALANCE_KEY,
          });
        } else {
          throw error;
        }
      }
    },
    [sequenceId, shots, queryClient, posthog, showBillingGate]
  );

  const musicPromptsReady = !!(sequence?.musicPrompt && sequence.musicTags);

  // GenerationProgressBanner is owned by the script-analysis pipeline
  // (sequence.status === 'processing'). Standalone motion gen runs when the
  // sequence is already 'completed' / 'ready', so it must render via the
  // dedicated MotionProgressBanner — never the 5-stage banner. Trusting
  // generationState.currentPhase here would let leftover phase events from
  // past runs hijack the UI back to the 5-stage banner.
  const isGenerationActive = isProcessing;
  const willEmail = isGenerationActive && !sequence.readyEmailSentAt;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isProcessing) {
      startTimeRef.current = null;
      setElapsedSeconds(0);
      return;
    }
    startTimeRef.current = sequence.updatedAt.getTime();
    const tick = () => {
      const start = startTimeRef.current ?? Date.now();
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isProcessing, sequenceId, sequence?.updatedAt]);

  const remainingSeconds = useMemo(() => {
    const phase1Completed = generationState.phases[0]?.status === 'completed';
    const sceneCount = phase1Completed ? generationState.scenes.length : 0;
    return Math.max(
      0,
      estimateTotalSeconds(
        sceneCount,
        sequence?.script ? estimateSceneCount(sequence.script) : undefined,
        generationState.phases.length
      ) - elapsedSeconds
    );
  }, [
    elapsedSeconds,
    generationState.phases,
    generationState.scenes.length,
    sequence?.script,
  ]);
  remainingRef.current = remainingSeconds;
  const etaMinutes = Math.max(1, Math.round(remainingSeconds / 60));

  // One prop bag for the desktop sidebar and the phone sheet — same list.
  const sceneListProps: SceneListProps = {
    sequenceId,
    shots,
    scenes,
    segments,
    loadError: shotsError ?? scenesError,
    segmentsError,
    selection,
    aspectRatio,
    onSelectScene: handleSelectScene,
    onSelectShot: handleSelectShot,
    onClearSelection: handleClearSelection,
    regeneratingImages,
    regeneratingMotion,
    onBatchGenerateMotion: handleBatchMotionGeneration,
    musicPromptsReady,
    hideBatchButton: phaseConfig.autoGenerateMotion && isGenerationActive,
    divergentVariants,
    onCompareDivergent: setCompareVariant,
    initialMusicModel: sequenceMusicModel,
    initialVideoModel: sequenceVideoModel,
    styleCategory,
    recommendedVideoModel,
    styleName,
    modelMissingShotIds: shotsMissingActiveImage,
    modelMissingLabel: activeImageModelLabel,
    staleShotIds: isGenerationActive ? undefined : staleShotIds,
  };

  return (
    <div className="flex h-full flex-col">
      {/* Generation progress banner */}
      {isGenerationActive && (
        <div className="pl-4 pr-4 pt-4 md:pr-8">
          <GenerationProgressBanner
            generationState={generationState}
            isProcessing={isProcessing}
            startedAt={sequence.updatedAt}
            script={sequence.script ?? undefined}
            remainingSeconds={remainingSeconds}
            willEmail={willEmail}
          />
        </div>
      )}

      {/* Motion generation progress banner */}
      {!isGenerationActive &&
        motionBannerState !== null &&
        sequence &&
        shots && (
          <div className="pl-4 pr-4 pt-4 md:pr-8">
            <MotionProgressBanner
              shots={shots}
              sequence={sequence}
              includeMusic={motionBannerState.includeMusic}
              startedAt={motionBannerState.startedAt}
              onComplete={resetGenerationStream}
            />
          </div>
        )}

      {/* Failure summary with smart retry — wait until the run finishes so a
          single in-flight miss doesn't headline the first result (#1286). */}
      {failureSummary?.hasFailed && !isGenerationActive && (
        <FailureSummaryBanner
          summary={failureSummary}
          onRetry={() => void handleSmartRetry()}
          onFullRetry={() => void handleSmartRetry()}
          isRetrying={isRetrying}
        />
      )}

      <div className="flex flex-1 min-h-0">
        <div className="hidden min-h-0 md:block shrink-0 pl-4 py-4">
          <SceneList {...sceneListProps} className="w-[280px] lg:w-[360px]" />
        </div>

        <div className="md:hidden">
          <MobileSceneDrawer {...sceneListProps} />
        </div>

        <div className="flex flex-1 min-h-0 min-w-0 flex-col md:flex-row">
          <div className="flex flex-1 min-h-0 min-w-0 flex-col">
            <CanvasViewToggle
              view={effectiveView}
              onViewChange={setView}
              canvasDisabled={!canvasReady}
              trailing={
                effectiveView === 'script' ? (
                  <CopyScriptButton sequenceId={sequenceId} />
                ) : null
              }
            />
            {/* flex-col so SceneCanvas's flex-1 chain still stretches — in a
                block parent the CanvasMediaStage size container computes 0
                height and the whole canvas collapses. */}
            <div
              className="relative flex min-h-0 flex-1 flex-col touch-pan-y overflow-hidden"
              {...canvasSwipe}
            >
              {effectiveView === 'script' ? (
                <SceneScriptDocument
                  sequenceId={sequenceId}
                  scenes={scenes}
                  selectedSceneIds={selectedScenes.map((s) => s.id)}
                  onSelectScene={handleFocusScene}
                  splittingScript={isProcessing ? sequence.script : undefined}
                />
              ) : (
                <SceneCanvas
                  selection={selection}
                  shots={shots}
                  scenes={scenes}
                  loadError={shotsError}
                  playerShots={playerShots}
                  sequence={sequence}
                  aspectRatio={aspectRatio}
                  selectedTab={effectiveTab}
                  overrideImageUrl={previewVariantUrl}
                  overrideVideoUrl={previewVariantVideoUrl}
                  badgeMessage={playerBadgeMessage}
                  modelMismatchLabel={
                    effectiveTab === 'image-prompt' &&
                    activeImageModelLabel &&
                    curSelectedShotId &&
                    shotsMissingActiveImage.has(curSelectedShotId)
                      ? `Not generated with ${activeImageModelLabel}`
                      : null
                  }
                  staleLabel={
                    !isGenerationActive &&
                    effectiveTab === 'image-prompt' &&
                    curSelectedShotId &&
                    !regeneratingImages.has(curSelectedShotId)
                      ? scopeStaleness?.[curSelectedShotId]?.thumbnail ===
                        'stale'
                        ? 'Out of date'
                        : scopeStaleness?.[curSelectedShotId]?.thumbnail ===
                            'updating'
                          ? 'Updating…'
                          : null
                      : null
                  }
                  progressMessage={
                    isGenerationActive ? (
                      <RenderWaitCopy
                        etaMinutes={etaMinutes}
                        willEmail={willEmail}
                      />
                    ) : (
                      generationState.phases.find((p) => p.status === 'active')
                        ?.phaseName
                    )
                  }
                  retry={selectedShotRetry}
                  onSelectShot={handleSelectShot}
                  sceneImageModel={resolvedImageModel}
                  regeneratingSceneVariants={regeneratingSceneVariants}
                  onGenerateSceneVariantsStart={(id) =>
                    handleRegenerateStart(id, 'scene-variants')
                  }
                  firstRunActive={isGenerationActive}
                />
              )}
            </div>
          </div>

          {/* One inspector: phone collapse bar + `hidden`/`md:flex`, desktop
              card. Same CSS-visibility rule as the scene list, one tree. */}
          <div className="relative z-10 shrink-0 border-t bg-background pb-20 md:min-h-0 md:border-0 md:bg-transparent md:pb-0 md:pr-4 md:py-4">
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between px-4 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden"
              aria-expanded={mobileInspectorOpen}
              aria-controls="scene-inspector"
              onClick={() => setMobileInspectorOpen((open) => !open)}
            >
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {scopeLabel[scope]}
              </span>
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none',
                  mobileInspectorOpen && 'rotate-180'
                )}
              />
            </button>
            <div
              id="scene-inspector"
              className={cn(
                'md:flex md:h-full md:min-h-0 md:w-[380px] lg:w-[420px] md:flex-col md:overflow-hidden md:rounded-lg md:border md:bg-background',
                mobileInspectorOpen ? 'block' : 'hidden'
              )}
            >
              <ScrollArea className="h-full min-h-0 max-md:max-h-[40dvh]">
                <SceneModelBar
                  scope={scope}
                  sequenceId={sequenceId}
                  resolvedSequenceImageModel={resolvedSequenceImageModel}
                  resolvedSequenceVideoModel={resolvedSequenceVideoModel}
                  styleId={sequence?.styleId ?? undefined}
                  stylePending={sequence?.styleConfig == null}
                  aspectRatio={aspectRatio}
                  analysisModel={sequence?.analysisModel ?? undefined}
                />
                <div className="px-4 pb-4">
                  <SceneScriptPrompts
                    shot={selectedShot}
                    sequenceId={sequenceId}
                    selectedTab={effectiveTab}
                    visibleTabs={visibleTabs}
                    onTabChange={(tab) => {
                      setSelectedTab(tab);
                      setFacet(tab);
                    }}
                    regeneratingImages={regeneratingImages}
                    regeneratingMotion={regeneratingMotion}
                    onRegenerateStart={handleRegenerateStart}
                    aspectRatio={aspectRatio}
                    variantForSelectedModel={variantForSelectedModel}
                    videoVariantForSelectedModel={videoVariantForSelectedModel}
                    segment={selectedSegment}
                    segmentSpanLabel={selectedSegmentSpanLabel}
                    resolvedImageModel={resolvedImageModel}
                    resolvedVideoModel={resolvedVideoModel}
                    imageModelStatuses={sceneImageModelStatuses}
                    videoModelStatuses={sceneVideoModelStatuses}
                    onImageModelChange={handleImageModelChange}
                    onVideoModelChange={handleVideoModelChange}
                    styleName={styleName}
                    recommendedImageModel={recommendedImageModel}
                    recommendedVideoModel={recommendedVideoModel}
                    styleCategory={styleCategory}
                    shotDivergentVariants={divergentVariants?.filter(
                      (v) => v.shotId === curSelectedShotId
                    )}
                    onCompareDivergent={(variant) => setCompareVariant(variant)}
                    facetShotIds={facetShotIds}
                    musicEditable={scope === 'sequence'}
                    scene={scriptScene}
                    scopeShots={scopeShots}
                    scopeStaleness={scopeStaleness}
                    scopeStalenessFailed={scopeStalenessFailed}
                    onSelectShot={handleSelectShot}
                  />
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      </div>

      {compareVariant &&
        (() => {
          const targetShot = shots?.find((f) => f.id === compareVariant.shotId);
          if (!targetShot) return null;
          return (
            <CompareWithPromptDiff
              sequenceId={sequenceId}
              shot={targetShot}
              variant={compareVariant}
              onClose={() => setCompareVariant(null)}
              onPromote={() => handlePromote(compareVariant)}
              onDiscard={() => handleDiscardWithUndo(compareVariant)}
              isPromoting={promoteVariant.isPending}
              isDiscarding={discardVariant.isPending}
            />
          );
        })()}
    </div>
  );
};
