import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { ThinkingBar } from '@/components/ai/thinking-bar';
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
import { buildMentionItems } from '@/components/scenes/prompt-mention/mention-items';
import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import { shortenPromptFn } from '@/functions/ai';
import { updateSceneScriptFn } from '@/functions/scenes';
import { generateShotImageFn } from '@/functions/shot-image';
import { generateShotMotionFn } from '@/functions/motion-functions';
import { regenerateShotPromptFn } from '@/functions/prompt-variants';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import {
  shotKeys,
  useGenerateVariants,
  useSelectVariant,
  useSetImageFromVariant,
  useSetVideoFromVariant,
} from '@/hooks/use-shots';
import {
  type ShotStaleness,
  shotStalenessKey,
  useShotStaleness,
} from '@/hooks/use-shot-staleness';
import { sequenceKeys } from '@/hooks/use-sequences';
import { sceneKeys } from '@/hooks/use-scenes';
import { useSaveShotPrompt } from '@/hooks/use-prompt-variants';
import type { FrameVariant, ShotVariant } from '@/lib/db/schema';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  getCompatibleModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  videoModelSupportsAudio,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import { useShotPromptStream } from '@/lib/realtime/use-shot-prompt-stream';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, History, Loader2, Minimize2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ShotStalenessBanners } from './shot-staleness-banners';
import { SceneScriptTab } from './scene-script-tab';
import { VariantSelector } from './variant-selector';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'scenes', 'scene-script-prompts']);

// Cast/Location/Elements left this panel for the selection-scoped inspector
// facets (#986) — this panel is now purely the shot's prompt/variant editor.
export type TabValue =
  | 'script'
  | 'image-prompt'
  | 'motion-prompt'
  | 'scene-variants';

function isInsufficientCreditsError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('INSUFFICIENT_CREDITS') ||
      error.message.includes('Insufficient credits')
    );
  }
  return false;
}

function isValidTabValue(value: string): value is TabValue {
  return (
    value === 'script' ||
    value === 'image-prompt' ||
    value === 'motion-prompt' ||
    value === 'scene-variants'
  );
}

type SceneScriptPromptsProps = {
  shot?: ShotWithImage | undefined;
  sequenceId: string;
  selectedTab: TabValue;
  onTabChange: (tab: TabValue) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  regeneratingSceneVariants: Set<string>;
  onRegenerateStart: (
    shotId: string,
    type: 'image' | 'motion' | 'scene-variants'
  ) => void;
  aspectRatio?: AspectRatio;
  /** Image variant (frame_variants, #989) for the scene's look model. */
  variantForSelectedModel?: FrameVariant;
  /** The selected scene's video variant for the effective video model (#545). */
  videoVariantForSelectedModel?: ShotVariant;
  /**
   * Resolved scene-level models (#909). Model selection lives on the scene, so
   * the image/motion tab selectors are seeded with these, and changing one
   * persists to the scene (whole-scene change) via the handlers below.
   */
  sceneImageModel: TextToImageModel;
  sceneVideoModel: ImageToVideoModel;
  /** Per-scene generation status by model — drives the ✓/⟳/! dropdown markers. */
  imageModelStatuses?: Map<string, ModelGenerationStatus>;
  videoModelStatuses?: Map<string, ModelGenerationStatus>;
  /** Persist a new look model on the selected shot's scene (#909). */
  onImageModelChange?: (model: TextToImageModel) => void;
  /** Persist a new motion model on the selected shot's scene (#909). */
  onVideoModelChange?: (model: ImageToVideoModel) => void;
  /** Current style category, used to snap style-restricted motion models. */
  styleCategory?: string;
  /** Current style name, used in recommendation tooltips. */
  styleName?: string;
  /** Style-recommended image model — drives the "Recommended" badge. */
  recommendedImageModel?: string | null;
  /** Style-recommended video model — drives the "Recommended" badge. */
  recommendedVideoModel?: string | null;
  /** Live divergent alternates for the current shot across variant types. */
  shotDivergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
};

export const SceneScriptPrompts: React.FC<SceneScriptPromptsProps> = ({
  shot,
  sequenceId,
  selectedTab,
  onTabChange,
  regeneratingImages,
  regeneratingMotion,
  regeneratingSceneVariants,
  onRegenerateStart,
  aspectRatio,
  variantForSelectedModel,
  videoVariantForSelectedModel,
  sceneImageModel,
  sceneVideoModel,
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
}) => {
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
    imagePrompt: '' as string,
    motionPrompt: '' as string,
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
  const [editedDurationSeconds, setEditedDurationSeconds] = useState<
    number | undefined
  >(undefined);
  const prevScriptShotIdRef = useRef<string | undefined>(undefined);

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
  const generateVariants = useGenerateVariants();
  const selectVariant = useSelectVariant();
  const setImageFromVariant = useSetImageFromVariant();
  const setVideoFromVariant = useSetVideoFromVariant();
  const {
    needsBillingSetup: falNeedsBillingSetup,
    showGate: showFalGate,
    gateProps: falGateProps,
    stripeEnabled,
  } = useFalBillingGate();

  const { data: staleness } = useShotStaleness({
    sequenceId,
    shotId: shot?.id,
  });

  // Sequence-scoped lists power the @-mention autocomplete in both prompt
  // editors. Same canonical tag the #683 server-side parser recognises.
  const { data: mentionElements } = useSequenceElements(sequenceId);
  const { data: mentionCharacters } = useSequenceCharacters(sequenceId);
  const { data: mentionLocations } = useSequenceLocations(sequenceId);
  const mentionItems = useMemo(
    () =>
      buildMentionItems({
        characters: mentionCharacters ?? [],
        elements: mentionElements ?? [],
        locations: mentionLocations ?? [],
      }),
    [mentionCharacters, mentionElements, mentionLocations]
  );
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
      if (!shot?.id) return { previous: undefined };
      const key = shotStalenessKey(shot.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ShotStaleness>(key);
      if (previous) {
        const promptKey =
          vars.promptType === 'visual' ? 'visualPrompt' : 'motionPrompt';
        queryClient.setQueryData<ShotStaleness>(key, {
          ...previous,
          [promptKey]: 'fresh',
        });
      }
      return { previous };
    },
    onSuccess: async (result, vars) => {
      if (result.alreadyUpToDate) {
        toast.info('Prompt is already up to date');
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
      if (shot?.id) {
        await queryClient.invalidateQueries({
          queryKey: shotStalenessKey(shot.id),
        });
      }
    },
    onError: (error, _vars, context) => {
      if (context?.previous && shot?.id) {
        queryClient.setQueryData(shotStalenessKey(shot.id), context.previous);
      }
      toast.error('Prompt regenerate failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
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
      queryKey: shotStalenessKey(shotId),
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
      queryKey: shotStalenessKey(shotId),
    });
  }, [shotPromptStream.motion.status, shotId, sequenceId, queryClient]);

  // Persist a scene-script and/or duration edit via `scene_script_versions`
  // (#1030). Repointing the selected version flips prompt-input-hash staleness
  // on the scene's shots without forking the sequence.
  const saveScriptMutation = useMutation({
    mutationFn: async (input: {
      nextExtract: string;
      nextDurationSeconds: number | undefined;
    }) => {
      if (!shot?.id) {
        throw new Error('shot required');
      }
      const { nextExtract, nextDurationSeconds } = input;
      return await updateSceneScriptFn({
        data: {
          sequenceId,
          shotId: shot.id,
          extract: nextExtract,
          ...(nextDurationSeconds !== undefined
            ? { durationSeconds: nextDurationSeconds }
            : {}),
        },
      });
    },
    onSuccess: async (updated) => {
      setEditedScript(undefined);
      setEditedDurationSeconds(undefined);
      queryClient.setQueryData(shotKeys.detail(updated.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: shotKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotStalenessKey(updated.id),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sceneKeys.composedScript(sequenceId),
        }),
      ]);
      toast.success('Scene saved');
    },
    onError: (error) => {
      toast.error('Failed to save scene', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

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

      try {
        await navigator.clipboard.writeText(text);
        setCopiedTab(tabName);
        setTimeout(() => setCopiedTab(null), 2000);
      } catch (error) {
        toast.error('Failed to copy', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    []
  );

  // Get imagePrompt early so it can be used in handleShortenPrompt
  const scriptText = shot?.metadata?.originalScript.extract;
  const imageModel = safeTextToImageModel(
    shot?.imageModel,
    DEFAULT_IMAGE_MODEL
  );
  // Model selection lives on the scene (#909): the image tab targets the
  // scene's look model, so the previewed variant + Generate/Set state all agree.
  const effectiveImageModel = sceneImageModel;
  const regenImageModel = sceneImageModel;
  // The scene's motion model, snapped to an aspect-ratio compatible model.
  const aspectCompatibleMotion = aspectRatio
    ? getCompatibleModel(sceneVideoModel, aspectRatio)
    : sceneVideoModel;
  const motionModelConfig = IMAGE_TO_VIDEO_MODELS[aspectCompatibleMotion];
  // Fall back to the default when the snapped model is gated to a different
  // style category (e.g. Seedance 2 is animation-only).
  const effectiveMotionModel: ImageToVideoModel =
    'requiredStyleCategory' in motionModelConfig &&
    motionModelConfig.requiredStyleCategory !== styleCategory
      ? DEFAULT_VIDEO_MODEL
      : aspectCompatibleMotion;
  const regenMotionModel = effectiveMotionModel;
  const imagePrompt = shot?.imagePrompt ?? undefined;

  const variantIsCompleted =
    variantForSelectedModel?.status === 'completed' &&
    !!variantForSelectedModel.url;
  const variantIsGenerating = variantForSelectedModel?.status === 'generating';
  const variantAlreadySet =
    variantIsCompleted && variantForSelectedModel.url === shot?.thumbnailUrl;

  // Has the selected image model produced an image for this scene — drives
  // Generate vs Regenerate (mirror of videoModelGenerated). Variant row (any
  // status) ⇒ attempted; legacy fallback covers shots with a primary
  // thumbnail but no variant row.
  const imageModelGenerated =
    !!variantForSelectedModel ||
    (!!shot?.thumbnailUrl && effectiveImageModel === imageModel);

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
        description: error instanceof Error ? error.message : 'Unknown error',
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
  const videoVariantAlreadySet =
    videoVariantIsCompleted &&
    videoVariantForSelectedModel.url === shot?.videoUrl;

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
        description: error instanceof Error ? error.message : 'Unknown error',
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

  const handleRegenerate = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    onRegenerateStart(shot.id, 'image');

    // Optimistic update for shot list query
    queryClient.setQueryData<ShotWithImage[]>(
      shotKeys.list(shot.sequenceId),
      (oldShots) => {
        if (!oldShots) return oldShots;
        return oldShots.map((f) =>
          f.id === shot.id
            ? {
                ...f,
                thumbnailStatus: 'generating' as const,
                imagePrompt: editedImagePrompt || f.imagePrompt,
                imageModel: regenImageModel,
              }
            : f
        );
      }
    );

    // Optimistic update for individual shot query
    queryClient.setQueryData<ShotWithImage>(
      shotKeys.detail(shot.id),
      (oldShot) => {
        if (!oldShot) return oldShot;
        return {
          ...oldShot,
          thumbnailStatus: 'generating' as const,
          imagePrompt: editedImagePrompt || oldShot.imagePrompt,
          imageModel: regenImageModel,
        };
      }
    );

    try {
      await generateShotImageFn({
        data: {
          sequenceId: shot.sequenceId,
          shotId: shot.id,
          model: regenImageModel,
          prompt: editedImagePrompt || undefined,
        },
      });

      // Don't invalidate immediately - let auto-polling pick up server updates
      // The optimistic update shows 'generating' instantly, and the workflow
      // will update the server status which auto-polling will detect
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      } else {
        toast.error('Image generation failed', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
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
    onRegenerateStart,
    showFalGate,
  ]);

  const handleRegenerateMotion = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    onRegenerateStart(shot.id, 'motion');

    // Optimistic update for shot list query
    queryClient.setQueryData<ShotWithImage[]>(
      shotKeys.list(shot.sequenceId),
      (oldShots) => {
        if (!oldShots) return oldShots;
        return oldShots.map((f) =>
          f.id === shot.id
            ? {
                ...f,
                videoStatus: 'generating' as const,
                motionPrompt: editedMotionPrompt || f.motionPrompt,
                motionModel: regenMotionModel,
              }
            : f
        );
      }
    );

    // Optimistic update for individual shot query
    queryClient.setQueryData<ShotWithImage>(
      shotKeys.detail(shot.id),
      (oldShot) => {
        if (!oldShot) return oldShot;
        return {
          ...oldShot,
          videoStatus: 'generating' as const,
          motionPrompt: editedMotionPrompt || oldShot.motionPrompt,
          motionModel: regenMotionModel,
        };
      }
    );

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
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      } else {
        toast.error('Motion generation failed', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
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
    onRegenerateStart,
    showFalGate,
  ]);

  const handleGenerateSceneVariants = useCallback(async () => {
    if (!shot?.id || !shot.sequenceId) return;

    onRegenerateStart(shot.id, 'scene-variants');

    try {
      await generateVariants.mutateAsync({
        sequenceId: shot.sequenceId,
        shotId: shot.id,
        model: regenImageModel,
      });
    } catch (error) {
      toast.error('Scene variants generation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [shot, generateVariants, regenImageModel, onRegenerateStart]);

  const handleVariantSelect = useCallback(
    async (index: number) => {
      if (!shot?.id || !shot.sequenceId) return;
      try {
        await selectVariant.mutateAsync({
          sequenceId: shot.sequenceId,
          shotId: shot.id,
          variantIndex: index,
        });
      } catch (error) {
        toast.error('Failed to select variant', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    [shot, selectVariant]
  );

  // The shot's selected motion prompt, projected from its version row (#713) —
  // metadata.prompts.motion no longer exists.
  const motionPromptData = shot?.motionPromptData ?? null;
  const characterTags = shot?.metadata?.continuity?.characterTags;

  // Raw prompt for editing (just motion direction, no dialogue/audio)
  const rawMotionPrompt =
    shot?.motionPrompt || motionPromptData?.fullPrompt || '';

  // Assembled preview: exactly what resolveMotionPrompt produces on the server.
  // Overlay any unsaved edit onto the structured prompt so the dialogue/audio
  // sections still appear for audio-capable models.
  const assembledPrompt = useMemo(() => {
    const overrideText = editedMotionPrompt || rawMotionPrompt;
    const mp: AssemblableMotionPrompt | null = motionPromptData
      ? {
          ...motionPromptData,
          fullPrompt: overrideText || motionPromptData.fullPrompt,
        }
      : overrideText
        ? { fullPrompt: overrideText, dialogue: null, audio: null }
        : null;
    return resolveMotionPrompt(
      {
        motionPrompt: mp,
        characterTags,
        description: shot?.description ?? null,
      },
      effectiveMotionModel
    );
  }, [
    editedMotionPrompt,
    rawMotionPrompt,
    motionPromptData,
    characterTags,
    shot?.description,
    effectiveMotionModel,
  ]);

  const motionModel = effectiveMotionModel;

  // Has the *currently-selected* video model produced a video for this scene —
  // drives Generate vs Regenerate (NOT whether the shot has any video, which
  // could be from a different model). A variant row (any status) means it was
  // attempted; the legacy fallback covers pre-#545 shots that carry a primary
  // video but no variant row.
  const videoModelGenerated =
    !!videoVariantForSelectedModel ||
    (!!shot?.videoUrl &&
      effectiveMotionModel ===
        safeImageToVideoModel(shot.motionModel, DEFAULT_VIDEO_MODEL));
  const maxPromptLength = IMAGE_TO_VIDEO_MODELS[motionModel].maxPromptLength;
  const isOverLimit = assembledPrompt.length > maxPromptLength;

  // Sync local state when props change (prev-value refs avoid extra re-renders)
  if (shot?.id !== prevScriptShotIdRef.current) {
    prevScriptShotIdRef.current = shot?.id;
    setEditedScript(undefined);
    setEditedDurationSeconds(undefined);
    // A new shot starts with a clean slate — its own saved prompt loads below.
    dirtyImageRef.current = false;
    dirtyMotionRef.current = false;
    imageFocusedRef.current = false;
    motionFocusedRef.current = false;
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
    shot?.thumbnailStatus === 'generating' ||
    (shot?.id ? regeneratingImages.has(shot.id) : false);

  // Check if motion is currently generating
  const isGeneratingMotion =
    shot?.videoStatus === 'generating' ||
    (shot?.id ? regeneratingMotion.has(shot.id) : false);

  const isGeneratingSceneVariants =
    shot?.variantImageStatus === 'generating' ||
    (shot?.id ? regeneratingSceneVariants.has(shot.id) : false);

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
      <ShotStalenessBanners
        shotId={shot?.id}
        sequenceId={sequenceId}
        onRegenerate={() => {
          onTabChange('image-prompt');
          if (falNeedsBillingSetup) {
            showFalGate();
            return;
          }
          void handleRegenerate();
        }}
      />

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
            <SelectItem value="scene-variants">Variants</SelectItem>
            <SelectItem value="script">Script</SelectItem>
            <SelectItem value="image-prompt">Image</SelectItem>
            <SelectItem value="motion-prompt">Motion</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: Tab buttons */}
      <TabsList className="hidden md:flex">
        <TabsTrigger value="scene-variants">Variants</TabsTrigger>
        <TabsTrigger value="script">Script</TabsTrigger>
        <TabsTrigger value="image-prompt" className="gap-1.5">
          Image
          {staleness?.visualPrompt === 'stale' && (
            <StalenessIndicator
              artifact="visual-prompt"
              entityType="shot"
              density="corner-dot"
              isRegenerating={isRegeneratingVisualPrompt}
            />
          )}
        </TabsTrigger>
        <TabsTrigger value="motion-prompt" className="gap-1.5">
          Motion
          {staleness?.motionPrompt === 'stale' && (
            <StalenessIndicator
              artifact="motion-prompt"
              entityType="shot"
              density="corner-dot"
              isRegenerating={isRegeneratingMotionPrompt}
            />
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="script">
        <SceneScriptTab
          shot={shot}
          sequenceId={sequenceId}
          scriptText={scriptText}
          motionModel={effectiveMotionModel}
          editedScript={editedScript}
          onEditedScriptChange={setEditedScript}
          editedDurationSeconds={editedDurationSeconds}
          onEditedDurationChange={setEditedDurationSeconds}
          isSaving={saveScriptMutation.isPending}
          onSave={(payload) => saveScriptMutation.mutate(payload)}
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
              <label
                htmlFor="image-prompt-input"
                className="text-sm font-medium"
              >
                Prompt
              </label>
              <span className="text-xs text-muted-foreground">
                {(editedImagePrompt || imagePrompt || '').length} characters
              </span>
            </div>
            <MarkdownEditor
              id="image-prompt-input"
              value={
                isStreamingVisualPrompt
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
                isStreamingVisualPrompt
                  ? 'Streaming prompt…'
                  : isGenerating
                    ? 'Prompt is being generated…'
                    : 'Enter image prompt… (type @ to insert elements, cast, locations)'
              }
              className="min-h-[120px]"
              disabled={isGenerating || isStreamingVisualPrompt}
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

          {/* Model selector — model selection is scene-level (#909): picking a
              model here persists to the whole scene, so all its shots share a
              look. */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <ImageModelSelector
              selectedModel={effectiveImageModel}
              onModelChange={(model) => onImageModelChange?.(model)}
              disabled={isGenerating}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
              generatedStatuses={imageModelStatuses}
            />
            <p className="text-xs text-muted-foreground">
              Changing the model sets it for the whole scene.
            </p>
          </div>

          {/* Shorten + History buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void handleShortenPrompt()}
              disabled={
                shortenStatus.loading ||
                isGenerating ||
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
              aria-label="Show visual prompt history"
            >
              <History className="mr-2 h-4 w-4" />
              History
            </Button>
          </div>

          {/* Prompt-stale regenerate banner */}
          {staleness?.visualPrompt === 'stale' && (
            <StalenessIndicator
              artifact="visual-prompt"
              entityType="shot"
              density="inline"
              onRegenerate={() =>
                regeneratePromptMutation.mutate({ promptType: 'visual' })
              }
              isRegenerating={isRegeneratingVisualPrompt}
            />
          )}

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
          )}

          {/* Copy button for current prompt */}
          <Button
            variant="outline"
            onClick={() =>
              void handleCopy(editedImagePrompt || imagePrompt, 'image-prompt')
            }
            disabled={!imagePrompt}
            className="w-full"
          >
            {copiedTab === 'image-prompt' ? (
              <span className="flex items-center gap-2">
                <span className="text-xs">✓</span> Copied
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <CopyIcon className="h-4 w-4" /> Copy Prompt
              </span>
            )}
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="motion-prompt">
        <div className="space-y-4">
          {/* Thinking bar while the model reasons, before the regenerated
              prompt starts streaming back ('pending' → first delta). */}
          <ThinkingBar active={shotPromptStream.motion.status === 'pending'} />

          {/* Editable raw motion prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="motion-prompt-input"
                className="text-sm font-medium"
              >
                Prompt
              </label>
              <span className="text-xs text-muted-foreground">
                {(editedMotionPrompt || rawMotionPrompt).length} characters
              </span>
            </div>
            <MarkdownEditor
              id="motion-prompt-input"
              value={
                isStreamingMotionPrompt
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
                isStreamingMotionPrompt
                  ? 'Streaming prompt…'
                  : isGeneratingMotion
                    ? 'Prompt is being generated…'
                    : 'Enter motion prompt… (type @ to insert elements, cast, locations)'
              }
              className="min-h-[120px]"
              disabled={
                isGenerating || isGeneratingMotion || isStreamingMotionPrompt
              }
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

          {/* Model selector — scene-level (#909): the chosen motion model
              applies to every shot in the scene. */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <MotionModelSelector
              selectedModel={effectiveMotionModel}
              onModelChange={(model) => onVideoModelChange?.(model)}
              disabled={isGenerating || isGeneratingMotion}
              aspectRatio={aspectRatio}
              styleCategory={styleCategory}
              recommendedVideoModel={recommendedVideoModel}
              styleName={styleName}
              generatedStatuses={videoModelStatuses}
            />
            <p className="text-xs text-muted-foreground">
              Changing the model sets it for the whole scene.
            </p>
          </div>

          {/* Assembled prompt preview */}
          {assembledPrompt && assembledPrompt !== editedMotionPrompt && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span
                  id="motion-assembled-prompt-heading"
                  className="text-sm font-medium"
                >
                  Optimised prompt
                </span>
                <span
                  className={`text-xs ${isOverLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}
                >
                  {assembledPrompt.length}&nbsp;/&nbsp;{maxPromptLength}
                </span>
              </div>
              <p
                id="motion-assembled-prompt-preview"
                aria-labelledby="motion-assembled-prompt-heading"
                className="whitespace-pre-wrap rounded-md border bg-muted/50 p-3 text-sm leading-relaxed text-foreground"
              >
                {assembledPrompt}
              </p>
            </div>
          )}

          {/* History button */}
          <Button
            type="button"
            variant="outline"
            onClick={() => setHistoryOpen('motion')}
            disabled={!shot}
            className="w-full"
            aria-label="Show motion prompt history"
          >
            <History className="mr-2 h-4 w-4" />
            History
          </Button>

          {/* Prompt-stale regenerate banner */}
          {staleness?.motionPrompt === 'stale' && (
            <StalenessIndicator
              artifact="motion-prompt"
              entityType="shot"
              density="inline"
              onRegenerate={() =>
                regeneratePromptMutation.mutate({ promptType: 'motion' })
              }
              isRegenerating={isRegeneratingMotionPrompt}
            />
          )}

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
          )}

          {/* Copy button for assembled prompt */}
          <Button
            variant="outline"
            onClick={() => void handleCopy(assembledPrompt, 'motion-prompt')}
            disabled={!assembledPrompt}
            className="w-full"
          >
            {copiedTab === 'motion-prompt' ? (
              <span className="flex items-center gap-2">
                <span className="text-xs">✓</span> Copied
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <CopyIcon className="h-4 w-4" /> Copy Prompt
              </span>
            )}
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="scene-variants">
        <div className="space-y-4">
          {/* Variant Selector */}
          {shot?.variantImageUrl ? (
            <VariantSelector
              variantImageUrl={shot.variantImageUrl}
              selectedVariantIndex={null} // TODO: Store selected variant index in frame metadata if needed
              onVariantSelect={(index) => void handleVariantSelect(index)}
              loading={isGeneratingSceneVariants || selectVariant.isPending}
              disabled={isGeneratingSceneVariants || selectVariant.isPending}
              aspectRatio={aspectRatio}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-muted-foreground/30 p-8 text-center text-sm text-muted-foreground">
              No variant image available. Generate variants to see options.
            </div>
          )}

          {/* Model selector — scene-level (#909). */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <ImageModelSelector
              selectedModel={effectiveImageModel}
              onModelChange={(model) => onImageModelChange?.(model)}
              disabled={isGenerating || isGeneratingSceneVariants}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
              generatedStatuses={imageModelStatuses}
            />
            <p className="text-xs text-muted-foreground">
              Changing the model sets it for the whole scene.
            </p>
          </div>

          {/* Regenerate button */}
          <Button
            onClick={() => {
              if (falNeedsBillingSetup) {
                showFalGate();
                return;
              }
              void handleGenerateSceneVariants();
            }}
            disabled={
              isGenerating ||
              isGeneratingSceneVariants ||
              generateVariants.isPending ||
              !shot
            }
            className="w-full"
          >
            {(isGeneratingSceneVariants || generateVariants.isPending) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {isGeneratingSceneVariants || generateVariants.isPending
              ? 'Generating…'
              : shot?.variantImageUrl
                ? 'Regenerate Scene Variants'
                : 'Generate Scene Variants'}
          </Button>
        </div>
      </TabsContent>

      <BillingGateDialog {...falGateProps} stripeEnabled={stripeEnabled} />

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
