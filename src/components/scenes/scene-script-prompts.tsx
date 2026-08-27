import { ThinkingBar } from '@/components/ai/thinking-bar';
import { ActionCost } from '@/components/billing/action-cost';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { PromptHistorySheet } from '@/components/prompts/prompt-history-sheet';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
import { useSequenceMentionItems } from '@/hooks/use-mention-items';
import { shortenPromptFn } from '@/functions/ai';
import { generateShotImageFn } from '@/functions/shot-image';
import { generateShotMotionFn } from '@/functions/motion-functions';
import { regenerateShotPromptFn } from '@/functions/prompt-variants';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { useFalPricing } from '@/hooks/use-fal-pricing';
import {
  shotKeys,
  useSelectSegmentVideoVersion,
  useSetImageFromVariant,
  useSetVideoFromVariant,
} from '@/hooks/use-shots';
import {
  SegmentVideoPanel,
  segmentPanelIsInformative,
} from '@/components/scenes/segment-video-panel';
import type { SequenceSegment } from '@/lib/scenes/scene-segments';
import type { UpdateStaleDepth } from '@/lib/shots/update-stale-depth';
import { copyTextToClipboard } from '@/lib/utils/clipboard';
import {
  type ShotStaleness,
  markArtifactFresh,
  shotIsStale,
  shotIsUpdating,
  shotStalenessNamespace,
  shotStalenessUnknown,
  useShotStaleness,
} from '@/hooks/use-shot-staleness';
import {
  sceneKeys,
  useSaveSceneScript,
  type SceneWithScript,
} from '@/hooks/use-scenes';
import { sceneFacetKeys } from '@/hooks/use-scene-facets';
import { useSaveShotPrompt } from '@/hooks/use-prompt-variants';
import type { FrameVariant, ShotVariant } from '@/lib/db/schema';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  getCompatibleModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  videoModelSupportsAudio,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  estimateImageCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import {
  aspectRatioToImageSize,
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { getStorageDomainFn } from '@/functions/storage-config';
import {
  OptimisedPromptPanel,
  promptFromFalInput,
  type OptimisedPromptPreview,
} from '@/components/scenes/optimised-prompt-panel';
import {
  CONTENT_REJECTION_USER_HINT,
  CONTENT_REJECTION_USER_TITLE,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { isNativeGrokVideoModel } from '@/lib/ai/grok-native';
import { buildImageRequest } from '@/lib/image/build-image-request';
import { buildGrokVideoRequest } from '@/lib/motion/build-grok-video-request';
import { buildMotionRequest } from '@/lib/motion/build-model-input';
import {
  buildMotionReferenceImages,
  buildShotImageReferenceImages,
} from '@/lib/motion/build-motion-references';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import { resolveShotDuration } from '@/lib/motion/resolve-shot-duration';
import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import { useShotPromptStream } from '@/lib/realtime/use-shot-prompt-stream';
import type { ShotView } from '@/lib/shots/shot-view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, History, Loader2, Minimize2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  SCENE_FACETS,
  type SceneFacet,
  type SelectionScope,
} from '@/lib/scenes/scene-selection';
import { errorMessage, isInsufficientCreditsError } from '@/lib/errors';
import { useUpdateStaleShots } from '@/hooks/use-update-stale-shots';
import { SceneCastTab } from './scene-cast-tab';
import { SceneStaleShots } from './scene-stale-shots';
import { SceneElementsTab } from './scene-elements-tab';
import { SceneLocationTab } from './scene-location-tab';
import { SceneMusicFacet } from './scene-music-facet';
import { SceneScriptTab } from './scene-script-tab';
import { ShotDurationField } from './shot-duration-field';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'scenes', 'scene-script-prompts']);

function toastGenerationError(label: string, error: unknown) {
  if (isContentRejectionError(error)) {
    toast.info(CONTENT_REJECTION_USER_TITLE, {
      description: CONTENT_REJECTION_USER_HINT,
    });
    return;
  }
  toast.error(label, { description: errorMessage(error) });
}

/** Inspector tab values ARE the URL facet tokens — one set, no mapping. */
export type TabValue = SceneFacet;

export type TabDescriptor = { value: TabValue; label: string };

/**
 * The inspector tabs shown for a given selection scope (#986). Tabs are
 * level-aware: prompt/script tabs need a single scene, music is a sequence-wide
 * concern, and cast/locations/elements apply at every level. Starting-frame
 * variants moved out of the tabs onto the canvas, so they're absent here.
 */
export function tabsForScope(scope: SelectionScope): TabDescriptor[] {
  if (scope === 'shot') {
    // No Script tab: the script is scene-scoped (`scene_script_versions` is
    // keyed by sceneId), so editing it from a shot would silently rewrite every
    // sibling shot's text. Shot scope keeps only what a shot actually owns — its
    // image and motion prompts.
    return [
      { value: 'cast', label: 'Cast' },
      { value: 'location', label: 'Locations' },
      { value: 'elements', label: 'Elements' },
      { value: 'image-prompt', label: 'Image' },
      { value: 'motion-prompt', label: 'Video' },
    ];
  }
  if (scope === 'scenes') {
    return [
      { value: 'script', label: 'Script' },
      { value: 'cast', label: 'Cast' },
      { value: 'location', label: 'Locations' },
      { value: 'elements', label: 'Elements' },
    ];
  }
  return [
    { value: 'cast', label: 'Cast' },
    { value: 'location', label: 'Locations' },
    { value: 'elements', label: 'Elements' },
    { value: 'music', label: 'Music' },
  ];
}

function isValidTabValue(value: string): value is TabValue {
  return (SCENE_FACETS as readonly string[]).includes(value);
}

/** Compact copy-to-clipboard icon for prompt headers. */
const PromptCopyButton: React.FC<{
  text: string | undefined;
  copyKey: string;
  copiedTab: string | null;
  onCopy: (text: string | undefined, key: string) => void;
  label: string;
}> = ({ text, copyKey, copiedTab, onCopy, label }) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    className="h-6 w-6"
    onClick={() => onCopy(text, copyKey)}
    disabled={!text}
    aria-label={label}
  >
    {copiedTab === copyKey ? (
      <span aria-hidden className="text-xs">
        ✓
      </span>
    ) : (
      <CopyIcon className="h-3.5 w-3.5" />
    )}
  </Button>
);

type SceneScriptPromptsProps = {
  shot?: ShotView | undefined;
  sequenceId: string;
  selectedTab: TabValue;
  /** Tabs to render for the current selection scope (#986). */
  visibleTabs: TabDescriptor[];
  onTabChange: (tab: TabValue) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onRegenerateStart: (
    shotId: string,
    type: 'image' | 'motion' | 'scene-variants'
  ) => void;
  aspectRatio?: AspectRatio;
  /** Image variant (frame_variants, #989) for the shot's look model. */
  variantForSelectedModel?: FrameVariant;
  /** The selected shot's video variant for the effective video model (#545). */
  videoVariantForSelectedModel?: ShotVariant;
  /** The render segment the selected shot belongs to (#986), if any. */
  segment?: SequenceSegment;
  /** Precomputed 1-based shot-span label for `segment` ("Shot 1" / "Shots 1–3"). */
  segmentSpanLabel?: string;
  /**
   * The models the shot's currently selected image / video versions were
   * rendered with (#1066), or the sequence default when nothing is selected
   * yet. These seed the image/motion tab selectors; changing one is a pick for
   * the NEXT generation (see the handlers below), not a write.
   */
  resolvedImageModel: TextToImageModel;
  resolvedVideoModel: ImageToVideoModel;
  /** Per-scene generation status by model — drives the ✓/⟳/! dropdown markers. */
  imageModelStatuses?: Map<string, ModelGenerationStatus>;
  videoModelStatuses?: Map<string, ModelGenerationStatus>;
  /** Pick the look model the next image generation runs with (#1066). */
  onImageModelChange?: (model: TextToImageModel) => void;
  /** Pick the motion model the next video generation runs with (#1066). */
  onVideoModelChange?: (model: ImageToVideoModel) => void;
  /** Current style category, used to snap style-restricted motion models. */
  styleCategory?: string;
  /** Style name, shown alongside the model selectors. */
  styleName?: string;
  /** Style-recommended models, surfaced as a hint in the selectors. */
  recommendedImageModel?: string | null;
  recommendedVideoModel?: string | null;
  /** Live divergent alternates for the current shot across variant types. */
  shotDivergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  /** Selection-scoped facet tags (#986). `null` = whole sequence. */
  /** Shot ids in the current selection; `null` = whole sequence. */
  facetShotIds?: string[] | null;
  /** Music facet editable only at sequence scope. */
  musicEditable?: boolean;
  /**
   * The scene in focus — the selected shot's scene at shot scope, the selected
   * scene at scene scope. Undefined when the selection spans several scenes (or
   * none), which renders the Script facet read-only rather than picking a target
   * for the user. Carries the selected script version (#1030) plus the
   * continuity/location the prompt previews resolve references against.
   */
  scene?: SceneWithScript;
  /**
   * The in-scope shots + their batched staleness (#1077) — the selected
   * scene's at scene scope, every shot at sequence scope. Drives the
   * stale-shot summary above the tabs.
   */
  scopeShots?: ShotView[];
  scopeStaleness?: Record<string, ShotStaleness>;
  /** The batched staleness request failed — surfaced instead of "all clear". */
  scopeStalenessFailed?: boolean;
  /** Navigate down to a shot — same handler the left rail uses. */
  onSelectShot?: (shotId: string) => void;
};

export const SceneScriptPrompts: React.FC<SceneScriptPromptsProps> = ({
  shot,
  sequenceId,
  selectedTab,
  visibleTabs,
  onTabChange,
  regeneratingImages,
  regeneratingMotion,
  onRegenerateStart,
  aspectRatio,
  variantForSelectedModel,
  videoVariantForSelectedModel,
  segment,
  segmentSpanLabel,
  resolvedImageModel,
  resolvedVideoModel,
  imageModelStatuses,
  videoModelStatuses,
  onImageModelChange,
  onVideoModelChange,
  styleCategory,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
  shotDivergentVariants,
  onCompareDivergent,
  facetShotIds = null,
  musicEditable = false,
  scene,
  scopeShots,
  scopeStaleness,
  scopeStalenessFailed,
  onSelectShot,
}) => {
  const scriptSceneId = scene?.id;
  const scriptText = scene?.script?.extract;
  const divergentImageVariant = useMemo(
    () => shotDivergentVariants?.find((v) => v.variantType === 'image'),
    [shotDivergentVariants]
  );
  const divergentVideoVariant = useMemo(
    () => shotDivergentVariants?.find((v) => v.variantType === 'video'),
    [shotDivergentVariants]
  );
  const [copiedTab, setCopiedTab] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<'visual' | 'motion' | null>(
    null
  );
  const [shortenStatus, setShortenStatus] = useState<{
    loading: boolean;
    error: string | null;
    success: string | null;
  }>({ loading: false, error: null, success: null });

  // Image & motion regeneration state
  const [editPrompts, setEditPrompts] = useState({
    imagePrompt: '',
    motionPrompt: '',
  });
  const { imagePrompt: editedImagePrompt, motionPrompt: editedMotionPrompt } =
    editPrompts;
  const setEditedImagePrompt = (v: string) =>
    setEditPrompts((s) => ({ ...s, imagePrompt: v }));
  const setEditedMotionPrompt = (v: string) =>
    setEditPrompts((s) => ({ ...s, motionPrompt: v }));
  // SFX/dialogue toggle for audio-capable models (kling v3, veo3, etc.)
  const [generateAudio, setGenerateAudio] = useState(true);

  // Script tab edit state — `undefined` means "no draft" (textarea mirrors the
  // saved value); a string means "user has typed". We reset to `undefined` when
  // the shot changes so switching scenes never shows the previous scene's draft.
  const [editedScript, setEditedScript] = useState<string | undefined>(
    undefined
  );
  const prevScriptSceneIdRef = useRef<string | undefined>(undefined);
  const prevPromptShotIdRef = useRef<string | undefined>(undefined);

  // Previous value tracking for prop-to-state sync (refs avoid extra re-renders)
  const prevImagePromptRef = useRef<string | undefined>(undefined);
  const prevMotionPromptRef = useRef<string | undefined>(undefined);

  // "Dirty" = the textarea holds an unsaved manual edit. Guards the prop sync
  // below so a background refetch (realtime event, window focus) can't clobber
  // an in-progress edit, and drives the Save/Cancel row's visibility. Cleared
  // on shot change, on Save/Cancel/Regenerate-prompt.
  const dirtyImageRef = useRef(false);
  const dirtyMotionRef = useRef(false);
  // The user has focused the editor at least once for this shot. Only edits
  // made AFTER focus count as manual — the MarkdownEditor (TipTap) can emit an
  // `onValueChange` on mount when it re-serializes the initial content (e.g.
  // mention tagification), which must NOT mark the prompt dirty or a Save button
  // appears on a prompt the user never touched.
  const imageFocusedRef = useRef(false);
  const motionFocusedRef = useRef(false);

  const queryClient = useQueryClient();
  const setImageFromVariant = useSetImageFromVariant();
  const setVideoFromVariant = useSetVideoFromVariant();
  const selectSegmentVideoVersion = useSelectSegmentVideoVersion();

  const handleSelectSegmentVersion = useCallback(
    (versionId: string) => {
      if (!shot) return;
      selectSegmentVideoVersion.mutate(
        { sequenceId, shotId: shot.id, versionId },
        {
          onError: (error) => {
            toast.error('Failed to switch video version', {
              description: errorMessage(error),
            });
          },
        }
      );
    },
    [shot, sequenceId, selectSegmentVideoVersion]
  );
  const { needsBillingSetup: falNeedsBillingSetup, showGate: showFalGate } =
    useFalBillingGate();

  const { data: staleness, isError: isStalenessError } = useShotStaleness({
    sequenceId,
    shotId: shot?.id,
  });

  // "Update all" (#1077) — enqueues the durable UpdateStaleShotsWorkflow,
  // which recomputes staleness server-side and regenerates whatever reads
  // stale then. This component only picks the scope; the hook polls the run
  // and reports what it did.
  const updateStaleShots = useUpdateStaleShots({ sequenceId });
  const handleUpdateAll = useCallback(
    (depth: UpdateStaleDepth) => {
      if (!shot?.id) return;
      if (falNeedsBillingSetup) {
        showFalGate();
        return;
      }
      updateStaleShots.run({ shotId: shot.id, depth });
    },
    [shot?.id, falNeedsBillingSetup, showFalGate, updateStaleShots]
  );
  const handleScopeUpdateAll = useCallback(
    (depth: UpdateStaleDepth) => {
      if (!scopeShots || !scopeStaleness) return;
      if (falNeedsBillingSetup) {
        showFalGate();
        return;
      }
      updateStaleShots.run({
        // Undefined at sequence scope → the workflow covers the whole sequence.
        sceneId: scriptSceneId,
        depth,
      });
    },
    [
      scopeShots,
      scopeStaleness,
      scriptSceneId,
      falNeedsBillingSetup,
      showFalGate,
      updateStaleShots,
    ]
  );

  const {
    items: mentionItems,
    characters: mentionCharacters,
    elements: mentionElements,
    locations: mentionLocations,
  } = useSequenceMentionItems(sequenceId);
  // The realtime hook owns the per-prompt-type stream status — `'pending'`
  // covers the window between a successful enqueue and the first delta, so
  // the button stays in its busy state without a sibling useState to sync.
  const { state: shotPromptStream, markPending: markPromptPending } =
    useShotPromptStream(shot?.id, Boolean(shot?.id));

  const regeneratePromptMutation = useMutation({
    mutationFn: (vars: {
      promptType: 'visual' | 'motion';
      force?: boolean;
    }) => {
      if (!shot?.id) throw new Error('shot required');
      return regenerateShotPromptFn({
        data: {
          sequenceId,
          shotId: shot.id,
          promptType: vars.promptType,
          force: vars.force,
        },
      });
    },
    // Optimistically mark the prompt as fresh so the stale-prompt banner clears
    // the moment the click registers — otherwise it lingers until the workflow
    // lands and staleness is re-queried. `isPending` flips on the same render,
    // which is what drives the button's `Regenerating…` label.
    onMutate: async (vars) => {
      // An explicit prompt regeneration discards the current draft (the LLM
      // streams a replacement), so drop the dirty guard for that axis — the
      // completion swap below should win.
      if (vars.promptType === 'visual') dirtyImageRef.current = false;
      else dirtyMotionRef.current = false;
      if (!shot?.id) return { rollback: undefined };
      await queryClient.cancelQueries({ queryKey: shotStalenessNamespace });
      const rollback = markArtifactFresh(
        queryClient,
        shot.id,
        vars.promptType === 'visual' ? 'visualPrompt' : 'motionPrompt'
      );
      return { rollback };
    },
    onSuccess: (result, vars) => {
      if (result.alreadyUpToDate) {
        toast.info('Prompt is already up to date');
      } else if (result.alreadyInFlight) {
        // Server-side dedup hit (#1085): a run — this tab's, another tab's,
        // or a teammate's — is already producing this prompt.
        toast.info('This prompt is already being regenerated');
      } else {
        // Workflow is now enqueued; hold the busy state via the stream's
        // `'pending'` status until deltas start arriving. Naturally cleared
        // when the DELTA/COMPLETED/FAILED reducer cases fire.
        markPromptPending(vars.promptType);
        toast.success(
          vars.promptType === 'visual'
            ? 'Regenerating visual prompt…'
            : 'Regenerating motion prompt…'
        );
      }
      // Deliberately no staleness invalidation here: the workflow has only been
      // enqueued, so a refetch now would answer 'stale' and undo the optimistic
      // write. The completion event invalidates the namespace instead.
    },
    onError: (error, _vars, context) => {
      context?.rollback?.();
      toast.error('Prompt regenerate failed', {
        description: errorMessage(error),
      });
    },
  });

  // Standalone Save: persist a hand-edited / shortened prompt as a `user-edit`
  // version without rendering. Before this, an edit only persisted if you then
  // clicked Generate; Shorten + manual edits were lost on the next refetch.
  const saveVisualPrompt = useSaveShotPrompt({
    sequenceId,
    shotId: shot?.id ?? '',
    promptType: 'visual',
  });
  const saveMotionPrompt = useSaveShotPrompt({
    sequenceId,
    shotId: shot?.id ?? '',
    promptType: 'motion',
  });

  const handleSaveVisualPrompt = useCallback(
    (text: string) => {
      saveVisualPrompt.mutate(text, {
        onSuccess: (r) => {
          dirtyImageRef.current = false;
          toast.success(r.unchanged ? 'No changes to save' : 'Prompt saved');
        },
        onError: (e) =>
          toast.error('Save failed', {
            description: e instanceof Error ? e.message : 'Unknown error',
          }),
      });
    },
    [saveVisualPrompt]
  );

  const handleSaveMotionPrompt = useCallback(
    (text: string) => {
      saveMotionPrompt.mutate(text, {
        onSuccess: (r) => {
          dirtyMotionRef.current = false;
          toast.success(r.unchanged ? 'No changes to save' : 'Prompt saved');
        },
        onError: (e) =>
          toast.error('Save failed', {
            description: e instanceof Error ? e.message : 'Unknown error',
          }),
      });
    },
    [saveMotionPrompt]
  );

  const isAwaitingVisualPrompt =
    shotPromptStream.visual.status === 'pending' ||
    shotPromptStream.visual.status === 'streaming';
  const isAwaitingMotionPrompt =
    shotPromptStream.motion.status === 'pending' ||
    shotPromptStream.motion.status === 'streaming';
  const isStreamingVisualPrompt =
    shotPromptStream.visual.status === 'streaming';
  const isStreamingMotionPrompt =
    shotPromptStream.motion.status === 'streaming';

  // Surface workflow failures as a toast — the workflow runs out-of-process
  // so the regenerate mutation's onError doesn't see them.
  const visualError = shotPromptStream.visual.error;
  const motionError = shotPromptStream.motion.error;
  useEffect(() => {
    if (shotPromptStream.visual.status === 'failed' && visualError) {
      toast.error('Visual prompt regenerate failed', {
        description: visualError,
      });
    }
  }, [shotPromptStream.visual.status, visualError]);
  useEffect(() => {
    if (shotPromptStream.motion.status === 'failed' && motionError) {
      toast.error('Motion prompt regenerate failed', {
        description: motionError,
      });
    }
  }, [shotPromptStream.motion.status, motionError]);

  // When a streamed regen lands, the workflow has already written the new
  // variant to the DB and emitted `generation.shot:updated` — refetch so
  // the textarea swaps from the live-streamed text to the persisted prompt
  // without a flicker.
  const shotId = shot?.id;
  useEffect(() => {
    if (!shotId) return;
    if (shotPromptStream.visual.status !== 'completed') return;
    void queryClient.invalidateQueries({
      queryKey: shotKeys.detail(shotId),
    });
    void queryClient.invalidateQueries({
      queryKey: shotKeys.list(sequenceId),
    });
    void queryClient.invalidateQueries({
      queryKey: shotStalenessNamespace,
    });
  }, [shotPromptStream.visual.status, shotId, sequenceId, queryClient]);
  useEffect(() => {
    if (!shotId) return;
    if (shotPromptStream.motion.status !== 'completed') return;
    void queryClient.invalidateQueries({
      queryKey: shotKeys.detail(shotId),
    });
    void queryClient.invalidateQueries({
      queryKey: shotKeys.list(sequenceId),
    });
    void queryClient.invalidateQueries({
      queryKey: shotStalenessNamespace,
    });
  }, [shotPromptStream.motion.status, shotId, sequenceId, queryClient]);

  // Persist a scene-script edit via `scene_script_versions` (#1030). Repointing
  // the selected version flips prompt-input-hash staleness on the scene's shots
  // without forking the sequence. Addressed by scene, not shot — see
  // `updateSceneScriptFn`. (Duration is a separate, per-shot video parameter —
  // see `ShotDurationField` on the Motion tab.)
  const saveSceneScript = useSaveSceneScript(sequenceId);
  const handleSaveScript = (nextExtract: string) => {
    if (!scriptSceneId) return;
    saveSceneScript.mutate(
      { sceneId: scriptSceneId, extract: nextExtract },
      {
        onSuccess: () => {
          setEditedScript(undefined);
          toast.success('Scene saved');
        },
        onError: (error) => {
          toast.error('Failed to save scene', {
            description: errorMessage(error),
          });
        },
      }
    );
  };

  // Per-prompt-type busy flag — `regeneratePromptMutation.variables` is the
  // payload of the in-flight request, so we know which tab's regenerate
  // triggered it. Without this, both tabs' indicators would show busy whenever
  // either was clicked.
  const inFlightPromptType = regeneratePromptMutation.isPending
    ? regeneratePromptMutation.variables?.promptType
    : null;
  const isRegeneratingVisualPrompt =
    inFlightPromptType === 'visual' || isAwaitingVisualPrompt;
  const isRegeneratingMotionPrompt =
    inFlightPromptType === 'motion' || isAwaitingMotionPrompt;

  const handleCopy = useCallback(
    async (text: string | undefined, tabName: string) => {
      if (!text) return;

      if (!(await copyTextToClipboard(text))) {
        toast.error('Failed to copy', {
          id: 'copy-prompt-failed',
          description:
            'Your browser blocked clipboard access. Select the prompt text to copy it manually.',
        });
        return;
      }
      setCopiedTab(tabName);
      setTimeout(() => setCopiedTab(null), 2000);
    },
    []
  );

  const imageModel = safeTextToImageModel(
    shot?.image?.model,
    DEFAULT_IMAGE_MODEL
  );
  // Model identity lives on the version that produced the asset (#1066): the
  // image tab targets the shot's resolved look model, so the previewed variant
  // + Generate/Set state all agree.
  const effectiveImageModel = resolvedImageModel;
  const regenImageModel = resolvedImageModel;
  // The resolved motion model, snapped to an aspect-ratio compatible model.
  const aspectCompatibleMotion = aspectRatio
    ? getCompatibleModel(resolvedVideoModel, aspectRatio)
    : resolvedVideoModel;
  const motionModelConfig = IMAGE_TO_VIDEO_MODELS[aspectCompatibleMotion];
  // Fall back to the default when the snapped model is gated to a different
  // style category (e.g. Seedance 2 is animation-only).
  const effectiveMotionModel: ImageToVideoModel =
    'requiredStyleCategory' in motionModelConfig &&
    motionModelConfig.requiredStyleCategory !== styleCategory
      ? DEFAULT_VIDEO_MODEL
      : aspectCompatibleMotion;
  const regenMotionModel = effectiveMotionModel;
  const imagePrompt = shot?.imagePromptVersion?.text ?? undefined;

  const variantIsCompleted =
    variantForSelectedModel?.status === 'completed' &&
    !!variantForSelectedModel.url;
  const variantIsGenerating = variantForSelectedModel?.status === 'generating';
  // Set Image only when the dropdown model differs from the model that
  // produced the *current* primary still. Comparing URLs to the latest
  // re-roll was wrong: same model + older selected version still showed Set
  // Image, and a newer unselected re-roll looked "not current" (#1070).
  const variantAlreadySet =
    variantIsCompleted &&
    !!shot?.image?.url &&
    effectiveImageModel === imageModel;

  // Has the selected image model produced an image for this scene — drives
  // Generate vs Regenerate (mirror of videoModelGenerated). Variant row (any
  // status) ⇒ attempted; legacy fallback covers shots with a primary
  // thumbnail but no variant row.
  const imageModelGenerated =
    !!variantForSelectedModel ||
    (!!shot?.image?.url && effectiveImageModel === imageModel);

  const handleSetImageFromVariant = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    try {
      await setImageFromVariant.mutateAsync({
        sequenceId: shot.sequenceId,
        shotId: shot.id,
        model: effectiveImageModel,
      });
    } catch (error) {
      toast.error('Failed to set image', {
        description: errorMessage(error),
      });
    }
  }, [shot, effectiveImageModel, setImageFromVariant]);

  // Video equivalents (#545): drive the "Set Video" action from the selected
  // scene's video variant for the picked model.
  const videoVariantIsCompleted =
    videoVariantForSelectedModel?.status === 'completed' &&
    !!videoVariantForSelectedModel.url;
  const videoVariantIsGenerating =
    videoVariantForSelectedModel?.status === 'generating';
  // Same rule as image: Set Video only when the dropdown model isn't the one
  // that produced the current primary clip (not URL equality to latest).
  const currentVideoModel = safeImageToVideoModel(
    shot?.video?.model,
    DEFAULT_VIDEO_MODEL
  );
  const videoVariantAlreadySet =
    videoVariantIsCompleted &&
    !!shot?.video?.url &&
    effectiveMotionModel === currentVideoModel;

  const handleSetVideoFromVariant = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    try {
      await setVideoFromVariant.mutateAsync({
        sequenceId: shot.sequenceId,
        shotId: shot.id,
        model: effectiveMotionModel,
      });
    } catch (error) {
      toast.error('Failed to set video', {
        description: errorMessage(error),
      });
    }
  }, [shot, effectiveMotionModel, setVideoFromVariant]);

  const handleShortenPrompt = useCallback(async () => {
    setShortenStatus({ loading: false, error: null, success: null });

    const currentPrompt = editedImagePrompt || imagePrompt;
    if (!currentPrompt || currentPrompt.length < 20) {
      setShortenStatus((s) => ({
        ...s,
        error: 'Prompt is too short to shorten',
      }));
      return;
    }

    setShortenStatus((s) => ({ ...s, loading: true }));

    try {
      const result = await shortenPromptFn({ data: { prompt: currentPrompt } });

      setEditedImagePrompt(result.shortenedPrompt);
      // Persist immediately — a shortened prompt is a real edit, not a throwaway
      // draft. Without this it'd be lost on the next refetch.
      handleSaveVisualPrompt(result.shortenedPrompt);
      const msg = `Prompt shortened by ${result.reductionPercent}% (${result.originalLength} → ${result.shortenedLength} chars)`;
      setShortenStatus({ loading: false, error: null, success: msg });
      // Clear success message after 5 seconds
      setTimeout(
        () => setShortenStatus((s) => ({ ...s, success: null })),
        5000
      );
    } catch (error) {
      logger.error('Failed to shorten prompt:', { err: error });
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to shorten prompt';
      setShortenStatus({ loading: false, error: errorMessage, success: null });
    }
  }, [editedImagePrompt, imagePrompt, handleSaveVisualPrompt]);

  // A regenerate with an edited prompt auto-links @-mentioned cast/elements/
  // locations into the scene continuity server-side (#683); refetch the scene
  // rows and the facet membership so the Cast tab reflects it (#1341).
  const invalidateContinuity = useCallback(() => {
    if (!shot?.sequenceId) return;
    void queryClient.invalidateQueries({
      queryKey: sceneKeys.list(shot.sequenceId),
    });
    void queryClient.invalidateQueries({
      queryKey: sceneFacetKeys.maps(shot.sequenceId),
    });
  }, [shot?.sequenceId, queryClient]);

  const handleRegenerate = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    const promptOverride = editedImagePrompt || undefined;

    onRegenerateStart(shot.id, 'image');

    // Optimistic update for shot list query
    queryClient.setQueryData<ShotView[]>(
      shotKeys.list(shot.sequenceId),
      (oldShots) => {
        if (!oldShots) return oldShots;
        return oldShots.map((f) =>
          f.id === shot.id
            ? {
                ...f,
                frame: { ...f.frame, imageStatus: 'generating' as const },
                imagePromptVersion:
                  promptOverride && f.imagePromptVersion
                    ? { ...f.imagePromptVersion, text: promptOverride }
                    : f.imagePromptVersion,
                image: f.image ? { ...f.image, model: regenImageModel } : null,
              }
            : f
        );
      }
    );

    // Optimistic update for individual shot query
    queryClient.setQueryData<ShotView>(shotKeys.detail(shot.id), (oldShot) => {
      if (!oldShot) return oldShot;
      return {
        ...oldShot,
        frame: { ...oldShot.frame, imageStatus: 'generating' as const },
        imagePromptVersion:
          promptOverride && oldShot.imagePromptVersion
            ? { ...oldShot.imagePromptVersion, text: promptOverride }
            : oldShot.imagePromptVersion,
        image: oldShot.image
          ? { ...oldShot.image, model: regenImageModel }
          : null,
      };
    });

    try {
      await generateShotImageFn({
        data: {
          sequenceId: shot.sequenceId,
          shotId: shot.id,
          model: regenImageModel,
          prompt: promptOverride,
        },
      });

      // Don't invalidate immediately - let auto-polling pick up server updates
      // The optimistic update shows 'generating' instantly, and the workflow
      // will update the server status which auto-polling will detect
      invalidateContinuity();
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      } else {
        toastGenerationError('Image generation failed', error);
      }

      // Rollback on error - set status to failed
      await queryClient.invalidateQueries({
        queryKey: shotKeys.list(shot.sequenceId),
      });
      await queryClient.invalidateQueries({
        queryKey: shotKeys.detail(shot.id),
      });
    }
  }, [
    shot,
    regenImageModel,
    editedImagePrompt,
    queryClient,
    invalidateContinuity,
    onRegenerateStart,
    showFalGate,
  ]);

  const handleRegenerateMotion = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    onRegenerateStart(shot.id, 'motion');

    const withEditedPrompt = (
      current: AssemblableMotionPrompt | null
    ): AssemblableMotionPrompt | null =>
      editedMotionPrompt
        ? {
            dialogue: current?.dialogue ?? null,
            audio: current?.audio ?? null,
            fullPrompt: editedMotionPrompt,
          }
        : current;

    // Optimistic update for shot list query
    queryClient.setQueryData<ShotView[]>(
      shotKeys.list(shot.sequenceId),
      (oldShots) => {
        if (!oldShots) return oldShots;
        return oldShots.map((f) =>
          f.id === shot.id
            ? {
                ...f,
                videoStatus: 'generating' as const,
                motionPrompt: withEditedPrompt(f.motionPrompt),
                video: f.video ? { ...f.video, model: regenMotionModel } : null,
              }
            : f
        );
      }
    );

    // Optimistic update for individual shot query
    queryClient.setQueryData<ShotView>(shotKeys.detail(shot.id), (oldShot) => {
      if (!oldShot) return oldShot;
      return {
        ...oldShot,
        videoStatus: 'generating' as const,
        motionPrompt: withEditedPrompt(oldShot.motionPrompt),
        video: oldShot.video
          ? { ...oldShot.video, model: regenMotionModel }
          : null,
      };
    });

    const motionModelForCall = regenMotionModel;
    const supportsAudio = videoModelSupportsAudio(motionModelForCall);

    try {
      await generateShotMotionFn({
        data: {
          sequenceId: shot.sequenceId,
          shotId: shot.id,
          model: regenMotionModel,
          prompt: editedMotionPrompt || undefined,
          generateAudio: supportsAudio ? generateAudio : undefined,
        },
      });

      // Don't invalidate immediately - let auto-polling pick up server updates
      invalidateContinuity();
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      } else {
        toastGenerationError('Motion generation failed', error);
      }

      // Rollback on error
      await queryClient.invalidateQueries({
        queryKey: shotKeys.list(shot.sequenceId),
      });
      await queryClient.invalidateQueries({
        queryKey: shotKeys.detail(shot.id),
      });
    }
  }, [
    shot,
    regenMotionModel,
    editedMotionPrompt,
    generateAudio,
    queryClient,
    invalidateContinuity,
    onRegenerateStart,
    showFalGate,
  ]);

  // The shot's selected motion prompt, projected from its version row (#713) —
  // metadata.prompts.motion no longer exists.
  const shotMotionPrompt = shot?.motionPrompt ?? null;
  const characterTags = scene?.continuity?.characterTags;
  // The scene shape the reference resolvers read (continuity tags, script text,
  // location) — the client mirror of what the workflows match against.
  const sceneReference = useMemo(
    () =>
      scene
        ? {
            continuity: scene.continuity,
            originalScript: scene.script,
            metadata: { location: scene.location ?? '' },
          }
        : null,
    [scene]
  );
  const sceneDescription = scene?.script?.extract ?? null;

  // Raw prompt for editing (just motion direction, no dialogue/audio)
  const rawMotionPrompt = shotMotionPrompt?.fullPrompt || '';

  // Assembled preview: exactly what resolveMotionPrompt produces on the server.
  // Overlay any unsaved edit onto the structured prompt so the dialogue/audio
  // sections still appear for audio-capable models.
  const assembledPrompt = useMemo(() => {
    const overrideText = editedMotionPrompt || rawMotionPrompt;
    const mp: AssemblableMotionPrompt | null = shotMotionPrompt
      ? {
          ...shotMotionPrompt,
          fullPrompt: overrideText || shotMotionPrompt.fullPrompt,
        }
      : overrideText
        ? { fullPrompt: overrideText, dialogue: null, audio: null }
        : null;
    return resolveMotionPrompt(
      {
        motionPrompt: mp,
        characterTags,
        description: sceneDescription,
        generateAudio,
      },
      effectiveMotionModel
    );
  }, [
    generateAudio,
    editedMotionPrompt,
    rawMotionPrompt,
    shotMotionPrompt,
    characterTags,
    sceneDescription,
    effectiveMotionModel,
  ]);

  // Transparent pricing under Generate Image / Generate Motion (#1140).
  const { pricing: falPricing } = useFalPricing();
  const imageCostEstimate = useMemo(() => {
    if (!falPricing) return null;
    return estimateImageCost(
      regenImageModel,
      aspectRatio ?? DEFAULT_ASPECT_RATIO,
      1,
      { pricing: falPricing }
    );
  }, [falPricing, regenImageModel, aspectRatio]);
  const motionCostEstimate = useMemo(() => {
    if (!falPricing || !shot) return null;
    const duration = resolveShotDuration({
      durationMs: shot.durationMs,
      model: effectiveMotionModel,
    });
    const hasReferenceImages =
      buildMotionReferenceImages({
        scene: sceneReference,
        characters: mentionCharacters ?? [],
        elements: mentionElements ?? [],
      }).length > 0;
    return estimateVideoCost(effectiveMotionModel, duration, {
      pricing: falPricing,
      hasReferenceImages,
    });
  }, [
    falPricing,
    shot,
    effectiveMotionModel,
    sceneReference,
    mentionCharacters,
    mentionElements,
  ]);

  // CDN-backed deployments absolutize stored /r2/ URLs at submit (toCdnUrl) —
  // fetch the server-only domain once so the preview shows the same final
  // URLs. Locally it's null and the preview keeps the stored relative URLs
  // (at submit those become fal-storage uploads we can't predict).
  const { data: storageConfig } = useQuery({
    queryKey: ['storage-domain'],
    queryFn: () => getStorageDomainFn(),
    staleTime: Infinity,
  });
  const storageDomain = storageConfig?.storageDomain ?? null;

  // Mirror of toCdnUrl for the client: absolutize only when the CDN domain
  // is configured, so prod previews show exactly what fal receives.
  const absolutizeUrl = useCallback(
    (url: string) =>
      storageDomain && url.startsWith('/r2/')
        ? `https://${storageDomain}/${url.slice('/r2/'.length)}`
        : url,
    [storageDomain]
  );

  // Exact request for the *selected* video model — same builder
  // submitMotionJob uses, including reference bindings. Other catalog
  // models are omitted (#1242): they inflate the inspector for picks the
  // user has not made. A transform rejection (e.g. no still yet) falls
  // back to the plain-text assembled prompt at render. Grok native uses
  // buildGrokVideoRequest so the panel shows <IMAGE_n> parts, not the fal
  // i2v bag.
  const motionRequestPreview = useMemo((): OptimisedPromptPreview | null => {
    if (!shot) return null;
    const modelKey = effectiveMotionModel;
    const config = IMAGE_TO_VIDEO_MODELS[modelKey];
    const referenceImages = buildMotionReferenceImages({
      scene: sceneReference,
      characters: mentionCharacters ?? [],
      elements: mentionElements ?? [],
    }).map((ref) => ({
      ...ref,
      referenceImageUrl: absolutizeUrl(ref.referenceImageUrl),
    }));
    const overrideText = editedMotionPrompt || rawMotionPrompt;
    const mp: AssemblableMotionPrompt | null = shotMotionPrompt
      ? {
          ...shotMotionPrompt,
          fullPrompt: overrideText || shotMotionPrompt.fullPrompt,
        }
      : overrideText
        ? { fullPrompt: overrideText, dialogue: null, audio: null }
        : null;
    try {
      const modelPrompt = resolveMotionPrompt(
        {
          motionPrompt: mp,
          characterTags,
          description: sceneDescription,
          generateAudio,
        },
        modelKey
      );
      if (!modelPrompt) return null;
      const duration = resolveShotDuration({
        explicit: undefined,
        durationMs: shot.durationMs,
        model: modelKey,
      });
      const imageUrl = absolutizeUrl(shot.image?.url ?? '');
      if (isNativeGrokVideoModel(modelKey)) {
        const request = buildGrokVideoRequest({
          prompt: modelPrompt,
          imageUrl,
          duration,
          aspectRatio,
          referenceImages,
          model: modelKey,
        });
        const textPart = request.input.prompt.find(
          (part) => part.type === 'text'
        );
        const prompt = textPart?.content ?? modelPrompt;
        return {
          modelName: config.name,
          endpointId: request.endpointId,
          prompt,
          json: JSON.stringify(request.input, null, 2),
          promptLength: prompt.length,
          maxPromptLength: config.maxPromptLength,
        };
      }
      const request = buildMotionRequest(
        {
          prompt: modelPrompt,
          imageUrl,
          duration,
          aspectRatio,
          generateAudio: videoModelSupportsAudio(modelKey)
            ? generateAudio
            : undefined,
          referenceImages,
        },
        modelKey
      );
      return {
        modelName: config.name,
        endpointId: request.endpointId,
        prompt: promptFromFalInput(request.input, modelPrompt),
        json: JSON.stringify(request.input, null, 2),
        promptLength: modelPrompt.length,
        maxPromptLength: config.maxPromptLength,
      };
    } catch {
      return null;
    }
  }, [
    shot,
    effectiveMotionModel,
    sceneReference,
    sceneDescription,
    mentionCharacters,
    mentionElements,
    editedMotionPrompt,
    rawMotionPrompt,
    shotMotionPrompt,
    characterTags,
    aspectRatio,
    generateAudio,
    absolutizeUrl,
  ]);

  // Exact fal request for the *selected* image model — same reference
  // resolution the `/image` trigger uses and the same request assembly the
  // workflow uses, so the panel shows the real endpoint payload including
  // inline (Image N) bindings. Hidden catalog models are skipped unless
  // they are the current pick (preview turbo).
  const imageRequestPreview = useMemo((): OptimisedPromptPreview | null => {
    const basePrompt = (editedImagePrompt || imagePrompt || '').trim();
    if (!basePrompt || !shot) return null;
    const modelKey = effectiveImageModel;
    const config = IMAGE_MODELS[modelKey];
    const referenceImages = buildShotImageReferenceImages({
      scene: sceneReference,
      visualPrompt: basePrompt,
      characters: mentionCharacters ?? [],
      locations: mentionLocations ?? [],
      elements: mentionElements ?? [],
    }).map((ref) => ({
      ...ref,
      referenceImageUrl: absolutizeUrl(ref.referenceImageUrl),
    }));
    try {
      const { prompt: enhancedPrompt, referenceUrls } =
        buildReferenceImagePrompt(
          basePrompt,
          referenceImages,
          config.maxPromptLength
        );
      const request = buildImageRequest({
        model: modelKey,
        prompt: enhancedPrompt,
        imageSize: aspectRatio
          ? aspectRatioToImageSize(aspectRatio)
          : undefined,
        numImages: 1,
        referenceImageUrls: referenceUrls,
      });
      return {
        modelName: config.name,
        endpointId: request.endpointId,
        prompt: promptFromFalInput(request.input, enhancedPrompt),
        json: JSON.stringify(request.input, null, 2),
        promptLength: enhancedPrompt.length,
        maxPromptLength: config.maxPromptLength,
      };
    } catch {
      return null;
    }
  }, [
    editedImagePrompt,
    imagePrompt,
    shot,
    effectiveImageModel,
    sceneReference,
    mentionCharacters,
    mentionElements,
    mentionLocations,
    aspectRatio,
    absolutizeUrl,
  ]);

  // Has the *currently-selected* video model produced a video for this scene —
  // drives Generate vs Regenerate (NOT whether the shot has any video, which
  // could be from a different model). A variant row (any status) means it was
  // attempted; the legacy fallback covers pre-#545 shots that carry a primary
  // video but no variant row.
  const videoModelGenerated =
    !!videoVariantForSelectedModel ||
    (!!shot?.video?.url &&
      effectiveMotionModel ===
        safeImageToVideoModel(shot.video.model, DEFAULT_VIDEO_MODEL));

  // Sync local state when props change (prev-value refs avoid extra re-renders)
  if (shot?.id !== prevPromptShotIdRef.current) {
    prevPromptShotIdRef.current = shot?.id;
    // A new shot starts with a clean slate — its own saved prompt loads below.
    dirtyImageRef.current = false;
    dirtyMotionRef.current = false;
    imageFocusedRef.current = false;
    motionFocusedRef.current = false;
  }
  // The script draft is keyed by SCENE, not shot: moving between shots of one
  // scene must not discard an in-progress script edit, because they all edit
  // the same script.
  if (scriptSceneId !== prevScriptSceneIdRef.current) {
    prevScriptSceneIdRef.current = scriptSceneId;
    setEditedScript(undefined);
  }

  // Swap the draft to the persisted prompt when it changes server-side (a
  // regenerate-prompt completion, a generate, a fresh shot) — UNLESS the user
  // has an unsaved manual edit in flight, which a background refetch must not
  // clobber.
  if (imagePrompt !== prevImagePromptRef.current) {
    prevImagePromptRef.current = imagePrompt;
    if (!dirtyImageRef.current) setEditedImagePrompt(imagePrompt || '');
  }

  if (rawMotionPrompt !== prevMotionPromptRef.current) {
    prevMotionPromptRef.current = rawMotionPrompt;
    if (!dirtyMotionRef.current) setEditedMotionPrompt(rawMotionPrompt);
  }

  // Show Save only when the user has actually edited the prompt (focused +
  // changed, via `dirty*Ref`) AND the edit differs from the saved value. The
  // `dirty` gate is what keeps Save hidden on a prompt the user only viewed —
  // the editor's on-mount re-serialization can change the draft text without
  // any user action, so a pure value-diff would show Save spuriously. Reading
  // the ref in render is safe here: every transition that flips it (a focused
  // keystroke, Save, Cancel, regenerate, shot change) coincides with a state
  // change that re-renders.
  const visualPromptDirty =
    !!shot &&
    dirtyImageRef.current &&
    editedImagePrompt.trim().length > 0 &&
    editedImagePrompt.trim() !== (imagePrompt ?? '').trim();
  const motionPromptDirty =
    !!shot &&
    dirtyMotionRef.current &&
    editedMotionPrompt.trim().length > 0 &&
    editedMotionPrompt.trim() !== rawMotionPrompt.trim();

  // Check if image is currently generating
  const isGenerating =
    shot?.frame.imageStatus === 'generating' ||
    (shot?.id ? regeneratingImages.has(shot.id) : false);

  // Check if motion is currently generating
  const isGeneratingMotion =
    shot?.videoStatus === 'generating' ||
    (shot?.id ? regeneratingMotion.has(shot.id) : false);

  // Anything on this shot out of date? Drives the status line (#1077). The
  // per-prompt optimistic 'fresh' writes clear the relevant term the moment a
  // regenerate is clicked, so the line retracts as the update progresses.
  // Suppressed while a regenerate is in flight — the busy controls already say
  // so, and "out of date" over a regenerating still just reads as stuck.
  const shotBusy = isGenerating || isGeneratingMotion;
  const shotHasStale = !!shot && !shotBusy && shotIsStale(staleness);
  // 'updating' (#1085): a server-side pending claim exists — some run (this
  // tab's, another tab's, a teammate's) is already regenerating the artifact.
  const shotHasUpdating = !!shot && !shotBusy && shotIsUpdating(staleness);
  // The comparison failed rather than came back clean — say so instead of
  // rendering the confident silence of an up-to-date shot.
  const shotStaleUnknown =
    !!shot &&
    !shotBusy &&
    (isStalenessError || shotStalenessUnknown(staleness));
  const isUpdatingAll = updateStaleShots.isRunning;
  const visualBusy =
    isRegeneratingVisualPrompt || staleness?.visualPrompt === 'updating';
  const motionBusy =
    isRegeneratingMotionPrompt || staleness?.motionPrompt === 'updating';

  return (
    <Tabs
      value={selectedTab}
      onValueChange={(value) => {
        if (isValidTabValue(value)) {
          onTabChange(value);
        }
      }}
      className="w-full"
    >
      {/* Staleness status line (#1077) — one quiet summary under the scope
          header instead of the old filled banners. "Update all" regenerates
          only what is stale now — it doesn't cascade into artifacts the
          regeneration outdates. Video stays a manual pick on its tab. */}
      {(shotHasStale || shotHasUpdating) && (
        <StalenessIndicator
          entityType="shot"
          density="status-line"
          message={shotHasStale ? undefined : 'Updating out-of-date artifacts…'}
          // Busy while OUR run is in flight, or while everything left is
          // already covered by a server-side claim (#1085) — clicking again
          // would just no-op against the dedup.
          isRegenerating={isUpdatingAll || !shotHasStale}
          onRegenerateDepth={shotHasStale ? handleUpdateAll : undefined}
          staleness={staleness}
          updateAllScope={
            shot ? { sequenceId, shotId: shot.id } : { sequenceId }
          }
        />
      )}
      {shotStaleUnknown && !shotHasStale && !shotHasUpdating && (
        <StalenessIndicator
          entityType="shot"
          density="status-line"
          tone="unknown"
          message="Couldn’t check whether this shot is up to date"
        />
      )}

      {/* Scene/sequence scope (#1077): same one-line pattern, ending in
          shot-number chips that navigate down to shot scope, plus a
          multi-shot Update all. */}
      {!shot && scopeShots && onSelectShot && (
        <SceneStaleShots
          shots={scopeShots}
          sequenceId={sequenceId}
          sceneId={scriptSceneId}
          staleness={scopeStaleness}
          stalenessFailed={scopeStalenessFailed}
          onSelectShot={onSelectShot}
          onUpdateAll={handleScopeUpdateAll}
          isUpdating={updateStaleShots.isRunning}
        />
      )}

      {/* Mobile: Select dropdown */}
      <div className="md:hidden">
        <Select
          value={selectedTab}
          onValueChange={(value) => {
            if (isValidTabValue(value)) {
              onTabChange(value);
            }
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {visibleTabs.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: content-sized list — avoid w-full, which stretches each
          flex-1 trigger and spaces short labels too far apart. */}
      <TabsList className="hidden md:inline-flex">
        {visibleTabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
            {t.value === 'image-prompt' &&
              (staleness?.visualPrompt === 'stale' ||
                staleness?.visualPrompt === 'updating') && (
                <StalenessIndicator
                  artifact="visual-prompt"
                  entityType="shot"
                  density="corner-dot"
                  isRegenerating={visualBusy}
                />
              )}
            {t.value === 'motion-prompt' &&
              (staleness?.motionPrompt === 'stale' ||
                staleness?.motionPrompt === 'updating') && (
                <StalenessIndicator
                  artifact="motion-prompt"
                  entityType="shot"
                  density="corner-dot"
                  isRegenerating={motionBusy}
                />
              )}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="script">
        <SceneScriptTab
          sceneId={scriptSceneId}
          scriptText={scriptText}
          editedScript={editedScript}
          onEditedScriptChange={setEditedScript}
          isSaving={saveSceneScript.isPending}
          onSave={handleSaveScript}
          isCopied={copiedTab === 'script'}
          onCopy={(text) => void handleCopy(text, 'script')}
          mentionItems={mentionItems}
        />
      </TabsContent>

      <TabsContent value="image-prompt">
        <div className="space-y-4">
          {/* Thinking bar while the model reasons, before the regenerated
              prompt starts streaming back ('pending' → first delta). */}
          <ThinkingBar active={shotPromptStream.visual.status === 'pending'} />

          {/* Error/Success Messages */}
          {shortenStatus.error && (
            <Alert variant="destructive">
              <AlertDescription>{shortenStatus.error}</AlertDescription>
            </Alert>
          )}

          {shortenStatus.success && (
            <Alert>
              <AlertDescription>{shortenStatus.success}</AlertDescription>
            </Alert>
          )}

          {/* Editable prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <label
                  htmlFor="image-prompt-input"
                  className="text-sm font-medium"
                >
                  Prompt
                </label>
                {/* Quiet stale chip on the artifact itself (#1077); the
                    optimistic 'fresh' write clears it the moment Regenerate
                    is clicked. */}
                {(staleness?.visualPrompt === 'stale' ||
                  staleness?.visualPrompt === 'updating') && (
                  <StalenessIndicator
                    artifact="visual-prompt"
                    entityType="shot"
                    density="header-chip"
                    isRegenerating={visualBusy}
                    onRegenerate={() =>
                      regeneratePromptMutation.mutate({
                        promptType: 'visual',
                      })
                    }
                  />
                )}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {
                    (isAwaitingVisualPrompt
                      ? shotPromptStream.visual.text
                      : editedImagePrompt || imagePrompt || ''
                    ).length
                  }{' '}
                  characters
                </span>
                <PromptCopyButton
                  text={editedImagePrompt || imagePrompt || ''}
                  copyKey="image-prompt-field"
                  copiedTab={copiedTab}
                  onCopy={(text, key) => void handleCopy(text, key)}
                  label="Copy image prompt"
                />
              </div>
            </div>
            <MarkdownEditor
              id="image-prompt-input"
              value={
                isAwaitingVisualPrompt
                  ? shotPromptStream.visual.text
                  : editedImagePrompt || imagePrompt || ''
              }
              onValueChange={(value) => {
                setEditedImagePrompt(value);
                // Only a change made after the user focused the editor is a real
                // edit; the editor's on-mount normalization emit is ignored.
                if (imageFocusedRef.current) dirtyImageRef.current = true;
              }}
              onFocus={() => {
                imageFocusedRef.current = true;
              }}
              placeholder={
                isAwaitingVisualPrompt
                  ? isStreamingVisualPrompt
                    ? 'Streaming prompt…'
                    : 'Regenerating prompt…'
                  : 'Enter image prompt… (type @ to insert elements, cast, locations)'
              }
              className="min-h-[120px]"
              // Lock while streaming so local edits can't fight the LLM.
              disabled={isAwaitingVisualPrompt}
              mentionItems={mentionItems}
            />
            {visualPromptDirty && (
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditedImagePrompt(imagePrompt || '');
                    dirtyImageRef.current = false;
                  }}
                  disabled={saveVisualPrompt.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleSaveVisualPrompt(editedImagePrompt)}
                  disabled={saveVisualPrompt.isPending}
                >
                  {saveVisualPrompt.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {saveVisualPrompt.isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </div>

          {/* Model selector — the model is per-asset (#1066): this is seeded
              from the shot's selected image version and picking a different one
              applies to the next generation. */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <ImageModelSelector
              selectedModel={effectiveImageModel}
              onModelChange={(model) => onImageModelChange?.(model)}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
              generatedStatuses={imageModelStatuses}
            />
            <p className="text-xs text-muted-foreground">
              Changing the model applies to the next generation. In-flight gens
              still finish into history.
            </p>
          </div>

          {/* Optimised prompt — selected image model only, collapsed
              until the user wants the assembled payload (#1242). */}
          {imageRequestPreview && (
            <OptimisedPromptPanel
              idPrefix="image-request"
              preview={imageRequestPreview}
              copiedKey={copiedTab}
              onCopy={(text, key) => void handleCopy(text, key)}
              footnote={
                !storageDomain
                  ? 'Relative /r2/ image URLs are made publicly fetchable at submit'
                  : null
              }
            />
          )}

          {/* Shorten + History buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void handleShortenPrompt()}
              disabled={
                shortenStatus.loading ||
                !editedImagePrompt ||
                editedImagePrompt.length < 20
              }
              className="flex-1"
            >
              {shortenStatus.loading && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {!shortenStatus.loading && <Minimize2 className="mr-2 h-4 w-4" />}
              {shortenStatus.loading ? 'Shortening…' : 'Shorten Prompt'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setHistoryOpen('visual')}
              disabled={!shot}
              aria-label="Show visual history"
            >
              <History className="mr-2 h-4 w-4" />
              History
            </Button>
          </div>

          {/* Explicit regenerate-prompt button — streams a fresh LLM
              completion straight into the textarea so the user sees the
              prompt forming. Routed through the shared mutation so
              `isPending` flips synchronously on click and the busy state
              shows instantly, instead of waiting for the realtime channel's
              first delta. */}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              regeneratePromptMutation.mutate({
                promptType: 'visual',
                force: true,
              })
            }
            disabled={!shot || isRegeneratingVisualPrompt}
            className="w-full"
            aria-label="Regenerate visual prompt"
          >
            {isRegeneratingVisualPrompt ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {isRegeneratingVisualPrompt ? 'Regenerating…' : 'Regenerate Prompt'}
          </Button>

          {divergentImageVariant && (
            <DivergentAlternateBanner
              variantId={divergentImageVariant.id}
              artifact="thumbnail"
              entityType="shot"
              onCompare={() => onCompareDivergent?.(divergentImageVariant)}
            />
          )}

          {/* Image action button — variant-aware */}
          {variantIsCompleted && !variantAlreadySet ? (
            <Button
              onClick={() => void handleSetImageFromVariant()}
              disabled={setImageFromVariant.isPending || !shot}
              className="w-full"
            >
              {setImageFromVariant.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {setImageFromVariant.isPending ? 'Setting…' : 'Set Image'}
            </Button>
          ) : (
            <div className="flex flex-col gap-1">
              <Button
                onClick={() => {
                  if (falNeedsBillingSetup) {
                    showFalGate();
                    return;
                  }
                  void handleRegenerate();
                }}
                disabled={isGenerating || variantIsGenerating || !shot}
                className="w-full"
              >
                {(isGenerating || variantIsGenerating) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {isGenerating || variantIsGenerating
                  ? 'Generating…'
                  : imageModelGenerated
                    ? 'Regenerate Image'
                    : 'Generate Image'}
              </Button>
              <ActionCost estimate={imageCostEstimate} />
            </div>
          )}
        </div>
      </TabsContent>

      <TabsContent value="motion-prompt">
        <div className="space-y-4">
          {/* Segment context (#986): video renders per render segment, not per
              shot. When this shot's segment spans multiple shots, has re-rolls to
              switch between, or is stale, surface it; otherwise (today's
              one-shot-per-segment reality) this stays hidden and the tab is
              unchanged. */}
          {segmentPanelIsInformative(segment) && (
            <SegmentVideoPanel
              segment={segment}
              spanLabel={segmentSpanLabel ?? ''}
              onSelectVersion={handleSelectSegmentVersion}
              selecting={selectSegmentVideoVersion.isPending}
            />
          )}

          {/* Duration is a video parameter, not a prompt driver — it belongs
              beside the model whose schema defines its legal values and the
              segment its value tiles into, not under the scene script. Keyed by
              shot so switching scenes drops any unsaved draft. */}
          <ShotDurationField
            key={shot?.id}
            shot={shot}
            sequenceId={sequenceId}
            motionModel={effectiveMotionModel}
            scriptExtract={scriptText}
          />

          {/* Thinking bar while the model reasons, before the regenerated
              prompt starts streaming back ('pending' → first delta). */}
          <ThinkingBar active={shotPromptStream.motion.status === 'pending'} />

          {/* Editable raw motion prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <label
                  htmlFor="motion-prompt-input"
                  className="text-sm font-medium"
                >
                  Prompt
                </label>
                {/* Quiet stale chip — same pattern as the image tab (#1077). */}
                {(staleness?.motionPrompt === 'stale' ||
                  staleness?.motionPrompt === 'updating') && (
                  <StalenessIndicator
                    artifact="motion-prompt"
                    entityType="shot"
                    density="header-chip"
                    isRegenerating={motionBusy}
                    onRegenerate={() =>
                      regeneratePromptMutation.mutate({
                        promptType: 'motion',
                      })
                    }
                  />
                )}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {
                    (isAwaitingMotionPrompt
                      ? shotPromptStream.motion.text
                      : editedMotionPrompt || rawMotionPrompt
                    ).length
                  }{' '}
                  characters
                </span>
                <PromptCopyButton
                  text={editedMotionPrompt || rawMotionPrompt}
                  copyKey="motion-prompt-field"
                  copiedTab={copiedTab}
                  onCopy={(text, key) => void handleCopy(text, key)}
                  label="Copy motion prompt"
                />
              </div>
            </div>
            <MarkdownEditor
              id="motion-prompt-input"
              value={
                isAwaitingMotionPrompt
                  ? shotPromptStream.motion.text
                  : editedMotionPrompt || rawMotionPrompt
              }
              onValueChange={(value) => {
                setEditedMotionPrompt(value);
                if (motionFocusedRef.current) dirtyMotionRef.current = true;
              }}
              onFocus={() => {
                motionFocusedRef.current = true;
              }}
              placeholder={
                isAwaitingMotionPrompt
                  ? isStreamingMotionPrompt
                    ? 'Streaming prompt…'
                    : 'Regenerating prompt…'
                  : 'Enter motion prompt… (type @ to insert elements, cast, locations)'
              }
              className="min-h-[120px]"
              // Lock while streaming so local edits can't fight the LLM.
              disabled={isAwaitingMotionPrompt}
              mentionItems={mentionItems}
            />
            {motionPromptDirty && (
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditedMotionPrompt(rawMotionPrompt);
                    dirtyMotionRef.current = false;
                  }}
                  disabled={saveMotionPrompt.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleSaveMotionPrompt(editedMotionPrompt)}
                  disabled={saveMotionPrompt.isPending}
                >
                  {saveMotionPrompt.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {saveMotionPrompt.isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </div>

          {/* Model selector — per-asset (#1066): seeded from the shot's selected
              video version; a pick applies to the next generation. */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <MotionModelSelector
              selectedModel={effectiveMotionModel}
              onModelChange={(model) => onVideoModelChange?.(model)}
              aspectRatio={aspectRatio}
              styleCategory={styleCategory}
              recommendedVideoModel={recommendedVideoModel}
              styleName={styleName}
              generatedStatuses={videoModelStatuses}
            />
            <p className="text-xs text-muted-foreground">
              Changing the model applies to the next generation.
            </p>
          </div>

          {/* Optimised prompt — selected video model only (#1242). When
              the request cannot be built (no still yet), fall back to the
              assembled prompt text if it differs from the editable field. */}
          {motionRequestPreview ? (
            <OptimisedPromptPanel
              idPrefix="motion-request"
              preview={motionRequestPreview}
              copiedKey={copiedTab}
              onCopy={(text, key) => void handleCopy(text, key)}
              footnote={
                !storageDomain
                  ? 'Relative /r2/ image URLs are made publicly fetchable at submit'
                  : null
              }
            />
          ) : assembledPrompt && assembledPrompt !== editedMotionPrompt ? (
            <OptimisedPromptPanel
              idPrefix="motion-assembled"
              preview={{
                modelName: IMAGE_TO_VIDEO_MODELS[effectiveMotionModel].name,
                endpointId: IMAGE_TO_VIDEO_MODELS[effectiveMotionModel].id,
                prompt: assembledPrompt,
                json: null,
                promptLength: assembledPrompt.length,
                maxPromptLength:
                  IMAGE_TO_VIDEO_MODELS[effectiveMotionModel].maxPromptLength,
              }}
              copiedKey={copiedTab}
              onCopy={(text, key) => void handleCopy(text, key)}
            />
          ) : null}

          {/* History button */}
          <Button
            type="button"
            variant="outline"
            onClick={() => setHistoryOpen('motion')}
            disabled={!shot}
            className="w-full"
            aria-label="Show motion history"
          >
            <History className="mr-2 h-4 w-4" />
            History
          </Button>

          {/* Explicit regenerate-prompt button — streams a fresh LLM
              completion straight into the textarea. See the image-prompt tab
              for the full rationale. */}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              regeneratePromptMutation.mutate({
                promptType: 'motion',
                force: true,
              })
            }
            disabled={!shot || isRegeneratingMotionPrompt}
            className="w-full"
            aria-label="Regenerate motion prompt"
          >
            {isRegeneratingMotionPrompt ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {isRegeneratingMotionPrompt ? 'Regenerating…' : 'Regenerate Prompt'}
          </Button>

          {divergentVideoVariant && (
            <DivergentAlternateBanner
              variantId={divergentVideoVariant.id}
              artifact="video"
              entityType="shot"
              onCompare={() => onCompareDivergent?.(divergentVideoVariant)}
            />
          )}

          {/* SFX/dialogue toggle — only for audio-capable models */}
          {videoModelSupportsAudio(effectiveMotionModel) && (
            <label
              htmlFor="scene-generate-audio"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Checkbox
                id="scene-generate-audio"
                checked={generateAudio}
                onCheckedChange={(checked) =>
                  setGenerateAudio(checked === true)
                }
                disabled={isGenerating || isGeneratingMotion}
              />
              <span>Include SFX &amp; dialogue</span>
            </label>
          )}

          {/* Motion action button — variant-aware (#545), mirror of the image
              tab: when the picked model already has a completed video for this
              scene, offer to Set it; otherwise Generate/Regenerate. */}
          {videoVariantIsCompleted && !videoVariantAlreadySet ? (
            <Button
              onClick={() => void handleSetVideoFromVariant()}
              disabled={setVideoFromVariant.isPending || !shot}
              className="w-full"
            >
              {setVideoFromVariant.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {setVideoFromVariant.isPending ? 'Setting…' : 'Set Video'}
            </Button>
          ) : (
            <div className="flex flex-col gap-1">
              <Button
                onClick={() => {
                  if (falNeedsBillingSetup) {
                    showFalGate();
                    return;
                  }
                  void handleRegenerateMotion();
                }}
                disabled={
                  isGenerating ||
                  isGeneratingMotion ||
                  videoVariantIsGenerating ||
                  !shot
                }
                className="w-full"
              >
                {(isGeneratingMotion || videoVariantIsGenerating) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {isGeneratingMotion || videoVariantIsGenerating
                  ? 'Generating…'
                  : videoModelGenerated
                    ? 'Regenerate Motion'
                    : 'Generate Motion'}
              </Button>
              <ActionCost estimate={motionCostEstimate} />
            </div>
          )}
        </div>
      </TabsContent>

      <TabsContent value="cast">
        <SceneCastTab sequenceId={sequenceId} shotIds={facetShotIds} />
      </TabsContent>

      <TabsContent value="location">
        <SceneLocationTab sequenceId={sequenceId} shotIds={facetShotIds} />
      </TabsContent>

      <TabsContent value="elements">
        <SceneElementsTab sequenceId={sequenceId} shotIds={facetShotIds} />
      </TabsContent>

      <TabsContent value="music">
        <SceneMusicFacet sequenceId={sequenceId} editable={musicEditable} />
      </TabsContent>

      {shot?.id && historyOpen && (
        <PromptHistorySheet
          open
          onOpenChange={(open) => !open && setHistoryOpen(null)}
          mode={historyOpen}
          sequenceId={sequenceId}
          shotId={shot.id}
          currentText={
            historyOpen === 'visual' ? imagePrompt || '' : rawMotionPrompt || ''
          }
        />
      )}
    </Tabs>
  );
};
