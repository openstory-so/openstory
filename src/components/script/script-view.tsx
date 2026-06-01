import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import {
  ElementSelector,
  type ElementSelectorHandle,
} from '@/components/element/element-selector';
import { GenerateSequenceIcon } from '@/components/icons/generate-sequence-icon';
import { LocationSuggestionSelector } from '@/components/location-library/location-suggestion-selector';
import { GenerationSettings } from '@/components/settings/generation-settings';
import { StyleSelector } from '@/components/style/style-selector';
import { TalentSuggestionSelector } from '@/components/talent/talent-suggestion-selector';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { PremiumCard } from '@/components/cards/premium-card';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { enhanceScriptStreamFn } from '@/functions/ai';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useBillingGate } from '@/hooks/use-billing-gate';
import { useGenerationSettings } from '@/hooks/use-generation-settings';
import { useSequenceDraft } from '@/hooks/use-sequence-draft';
import type { DraftElementUpload } from '@/hooks/use-sequence-elements';
import { useCreateSequence } from '@/hooks/use-sequences';
import { useStyles } from '@/hooks/use-styles';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  isValidAnalysisModelId,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  aspectRatioSchema,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import {
  dataTransferHasImages,
  extractImagesFromSnapshot,
  snapshotDataTransfer,
  toastDragImportCorsError,
} from '@/lib/utils/drag-images';
import type { Sequence } from '@/types/database';
import { usePostHog } from '@posthog/react';
import { ImagePlus, Loader2, Sparkles, Square, Undo2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { ScriptEditor } from './script-editor';

const SCRIPT_SHORT_THRESHOLD = 1000;

const DURATION_PRESETS = [
  { value: '15', label: '15s', seconds: 15 },
  { value: '30', label: '30s', seconds: 30 },
  { value: '60', label: '1m', seconds: 60 },
  { value: '120', label: '2m', seconds: 120 },
  { value: '180', label: '3m', seconds: 180 },
] as const;

export const ScriptView: FC<{
  teamId?: string;
  sequence?: Sequence;
  flat?: boolean;
  loading?: boolean;
  onSuccess?: (sequenceIds: string[]) => void;
  onCancel?: () => void;
}> = ({ teamId, sequence, loading = false, onSuccess, flat, onCancel }) => {
  // Local content state - undefined until user makes an edit
  const [contentState, setContentState] = useState<{
    script: string | null | undefined;
    styleId: string | null;
  }>({
    script: sequence?.script,
    styleId: sequence?.styleId || null,
  });
  const { script, styleId } = contentState;
  const setScript = (v: string | null | undefined) =>
    setContentState((s) => ({ ...s, script: v }));
  const setStyleId = (v: string | null) =>
    setContentState((s) => ({ ...s, styleId: v }));

  // Load saved settings from localStorage
  const {
    settings: savedSettings,
    isLoaded: settingsLoaded,
    save: saveSettings,
  } = useGenerationSettings();

  // Load draft from localStorage (script, style, talent, location)
  const {
    draft,
    isLoaded: draftLoaded,
    saveDraft,
    clearDraft,
  } = useSequenceDraft();

  // Determine if we're editing an existing sequence
  const isEditing = !!sequence?.id;

  // Initialize with sequence values (if editing) or localStorage defaults (if creating)
  const sequenceAnalysisModels: AnalysisModelId[] = useMemo(() => {
    if (isEditing && sequence.analysisModel) {
      return isValidAnalysisModelId(sequence.analysisModel)
        ? [sequence.analysisModel]
        : [DEFAULT_ANALYSIS_MODEL];
    }
    return savedSettings.analysisModels;
  }, [isEditing, sequence?.analysisModel, savedSettings.analysisModels]);

  const [genSettings, setGenSettings] = useState<{
    analysisModels: AnalysisModelId[];
    aspectRatio: AspectRatio;
    imageModels: TextToImageModel[];
    videoModels: ImageToVideoModel[];
    autoGenerateMotion: boolean;
    audioModels: AudioModel[];
    autoGenerateMusic: boolean;
  }>(() => ({
    analysisModels: sequenceAnalysisModels,
    aspectRatio: isEditing ? sequence.aspectRatio : savedSettings.aspectRatio,
    imageModels:
      isEditing && sequence.imageModel
        ? [safeTextToImageModel(sequence.imageModel, DEFAULT_IMAGE_MODEL)]
        : savedSettings.imageModels,
    videoModels:
      isEditing && sequence.videoModel
        ? [safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL)]
        : savedSettings.videoModels,
    autoGenerateMotion: isEditing ? false : savedSettings.autoGenerateMotion,
    audioModels:
      isEditing && sequence.musicModel
        ? [safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL)]
        : savedSettings.audioModels,
    autoGenerateMusic: isEditing ? false : savedSettings.autoGenerateMusic,
  }));
  const {
    analysisModels,
    aspectRatio,
    imageModels,
    videoModels,
    autoGenerateMotion,
    audioModels,
    autoGenerateMusic,
  } = genSettings;
  const updateGen = <K extends keyof typeof genSettings>(
    key: K,
    value: (typeof genSettings)[K]
  ) => setGenSettings((s) => ({ ...s, [key]: value }));
  const [selections, setSelections] = useState({
    talentIds: sequence?.suggestedTalentIds ?? [],
    locationIds: sequence?.suggestedLocationIds ?? [],
  });
  const { talentIds: selectedTalentIds, locationIds: selectedLocationIds } =
    selections;
  const [draftElements, setDraftElements] = useState<DraftElementUpload[]>([]);
  const [isElementBusy, setIsElementBusy] = useState(false);
  const elementSelectorRef = useRef<ElementSelectorHandle>(null);
  const dragCounterRef = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  const allowElementDrop = !loading && (!isEditing || !!sequence);

  const hasDraggedImages = (e: React.DragEvent<HTMLElement>) =>
    dataTransferHasImages(e.dataTransfer);

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!allowElementDrop || !hasDraggedImages(e)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDraggingFiles(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!allowElementDrop || !hasDraggedImages(e)) return;
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingFiles(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!allowElementDrop || !hasDraggedImages(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!allowElementDrop || !hasDraggedImages(e)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingFiles(false);
    const snapshot = snapshotDataTransfer(e.dataTransfer);
    void extractImagesFromSnapshot(snapshot).then(({ files, failedUrls }) => {
      if (files.length > 0) {
        elementSelectorRef.current?.addFiles(files);
        elementSelectorRef.current?.open();
        return;
      }
      if (failedUrls.length > 0) {
        toastDragImportCorsError();
      }
    });
  };

  const posthog = usePostHog();

  const { data: styles = [], isLoading: isLoadingStyles } = useStyles();

  // Auto-select first style if none selected
  useEffect(() => {
    const firstStyle = styles[0];
    if (!isLoadingStyles && firstStyle && !styleId && !sequence?.styleId) {
      setStyleId(firstStyle.id);
    }
  }, [styles, isLoadingStyles, styleId, sequence?.styleId]);

  // Derive style metadata for motion model filtering + recommendation badges
  const selectedStyle = useMemo(
    () => styles.find((s) => s.id === (styleId || sequence?.styleId)),
    [styles, styleId, sequence?.styleId]
  );
  const styleCategory = selectedStyle?.category ?? undefined;
  const styleName = selectedStyle?.name ?? undefined;
  const recommendedImageModel = selectedStyle?.recommendedImageModel ?? null;
  const recommendedVideoModel = selectedStyle?.recommendedVideoModel ?? null;
  const recommendedAspectRatio = selectedStyle?.defaultAspectRatio ?? null;

  // Sync draft state when creating new sequences (not editing)
  const hasSyncedDraftRef = React.useRef(false);
  useEffect(() => {
    if (isEditing || loading) {
      hasSyncedDraftRef.current = false;
      return;
    }
    if (!draftLoaded) return;
    if (!hasSyncedDraftRef.current && draft.script) {
      setContentState((s) => ({
        script: draft.script,
        styleId: draft.styleId || s.styleId,
      }));
      setSelections((s) => ({
        talentIds:
          draft.selectedTalentIds.length > 0
            ? draft.selectedTalentIds
            : s.talentIds,
        locationIds:
          draft.selectedLocationIds.length > 0
            ? draft.selectedLocationIds
            : s.locationIds,
      }));
      if (draft.elementUploads.length > 0) {
        setDraftElements(draft.elementUploads);
      }
      hasSyncedDraftRef.current = true;
    }
  }, [isEditing, loading, draftLoaded, draft]);

  // Sync state with savedSettings when creating new sequences (not when editing)
  // Use a ref to track if we've already synced to avoid loops
  const hasSyncedRef = React.useRef(false);
  useEffect(() => {
    // Reset sync flag when switching modes
    if (isEditing) {
      hasSyncedRef.current = false;
      return;
    }
    // Wait for localStorage to load before syncing
    if (!settingsLoaded) {
      return;
    }
    // Sync once when creating new sequence
    if (!hasSyncedRef.current) {
      setGenSettings({
        aspectRatio: savedSettings.aspectRatio,
        analysisModels: savedSettings.analysisModels,
        imageModels: savedSettings.imageModels,
        videoModels: savedSettings.videoModels,
        autoGenerateMotion: savedSettings.autoGenerateMotion,
        audioModels: savedSettings.audioModels,
        autoGenerateMusic: savedSettings.autoGenerateMusic,
      });
      hasSyncedRef.current = true;
    }
  }, [isEditing, settingsLoaded, savedSettings]);

  // Persist settings to localStorage when creating new sequences (not when editing)
  // Only save after initial load to prevent overwriting with defaults
  useEffect(() => {
    if (!isEditing && settingsLoaded) {
      saveSettings(genSettings);
    }
  }, [isEditing, settingsLoaded, genSettings, saveSettings]);

  // Persist draft to localStorage when creating new sequences
  useEffect(() => {
    if (!isEditing && draftLoaded) {
      saveDraft({
        script: script ?? '',
        styleId,
        selectedTalentIds,
        selectedLocationIds,
        elementUploads: draftElements,
      });
    }
  }, [
    isEditing,
    draftLoaded,
    script,
    styleId,
    selectedTalentIds,
    selectedLocationIds,
    draftElements,
    saveDraft,
  ]);

  // Auto-fallback motion models when style changes away from a required
  // category — any selected model whose requiredStyleCategory no longer matches
  // is swapped for the default; the result is deduped.
  useEffect(() => {
    const coerced = videoModels.map((m) => {
      const model = IMAGE_TO_VIDEO_MODELS[m];
      return 'requiredStyleCategory' in model &&
        model.requiredStyleCategory !== styleCategory
        ? DEFAULT_VIDEO_MODEL
        : m;
    });
    const deduped = [...new Set(coerced)];
    if (
      deduped.length !== videoModels.length ||
      deduped.some((m, i) => m !== videoModels[i])
    ) {
      updateGen('videoModels', deduped);
    }
  }, [styleCategory, videoModels]);

  // Auto-apply style recommendations on style change. Issue #716 originally
  // said "suggest, never auto-change", but in practice most users never open
  // the settings popover, so badges alone don't drive adoption of the
  // recommended models. We override + show a "From {Style} · Reset" pill so
  // the user can back out with a single click.
  //
  // The seed value of `lastAppliedStyleIdRef` is the sequence's stored styleId
  // when editing (so we don't clobber existing values on mount) or null when
  // creating (so the first auto-selected style triggers the apply).
  const lastAppliedStyleIdRef = useRef<string | null>(
    sequence?.styleId ?? null
  );
  const styleApplySnapshotRef = useRef<{
    aspectRatio: AspectRatio;
    imageModels: TextToImageModel[];
    videoModels: ImageToVideoModel[];
  } | null>(null);
  const [appliedFromStyle, setAppliedFromStyle] = useState<{
    styleId: string;
    styleName: string;
  } | null>(null);

  useEffect(() => {
    // Wait for localStorage sync in create mode so we don't snapshot a
    // pre-sync default and then have savedSettings overwrite the applied
    // values immediately after.
    if (!isEditing && !settingsLoaded) return;

    const id = selectedStyle?.id;
    if (!id || id === lastAppliedStyleIdRef.current) return;

    const validImage =
      recommendedImageModel && isValidTextToImageModel(recommendedImageModel)
        ? recommendedImageModel
        : null;
    const validVideo =
      recommendedVideoModel && isValidImageToVideoModel(recommendedVideoModel)
        ? recommendedVideoModel
        : null;
    const parsedRatio = recommendedAspectRatio
      ? aspectRatioSchema.safeParse(recommendedAspectRatio)
      : null;
    const validRatio = parsedRatio?.success ? parsedRatio.data : null;

    lastAppliedStyleIdRef.current = id;

    // Always restore the existing snapshot first (if any) so chained style
    // switches measure against the user's pre-auto-apply baseline, never
    // against another style's applied values. Switching to a style with no
    // recommendations therefore lands the user back on their baseline rather
    // than stranding them on the previous style's recommendations.
    const baseline = styleApplySnapshotRef.current;

    if (!validImage && !validVideo && !validRatio) {
      if (baseline) {
        setGenSettings((s) => ({ ...s, ...baseline }));
      }
      styleApplySnapshotRef.current = null;
      setAppliedFromStyle(null);
      return;
    }

    setGenSettings((s) => {
      const start = baseline ?? {
        aspectRatio: s.aspectRatio,
        imageModels: s.imageModels,
        videoModels: s.videoModels,
      };
      styleApplySnapshotRef.current = start;
      return {
        ...s,
        aspectRatio: validRatio ?? start.aspectRatio,
        imageModels: validImage ? [validImage] : start.imageModels,
        videoModels: validVideo ? [validVideo] : start.videoModels,
      };
    });
    setAppliedFromStyle({
      styleId: id,
      styleName: selectedStyle?.name ?? 'this style',
    });
  }, [
    isEditing,
    settingsLoaded,
    selectedStyle?.id,
    selectedStyle?.name,
    recommendedImageModel,
    recommendedVideoModel,
    recommendedAspectRatio,
  ]);

  const resetStyleDefaults = () => {
    const snapshot = styleApplySnapshotRef.current;
    if (!snapshot) return;
    setGenSettings((s) => ({ ...s, ...snapshot }));
    styleApplySnapshotRef.current = null;
    setAppliedFromStyle(null);
  };

  const [targetDuration, setTargetDuration] = useState(30);
  const [enhancePopoverOpen, setEnhancePopoverOpen] = useState(false);

  const [enhanceUI, setEnhanceUI] = useState({
    isEnhancing: false,
    error: null as string | null,
    showRegenerateConfirm: false,
    showEnhanceNudge: false,
    canUndoEnhance: false,
  });
  const {
    isEnhancing,
    error: enhanceError,
    showRegenerateConfirm,
    showEnhanceNudge,
    canUndoEnhance,
  } = enhanceUI;
  const setEnhance = <K extends keyof typeof enhanceUI>(
    key: K,
    value: (typeof enhanceUI)[K]
  ) => setEnhanceUI((s) => ({ ...s, [key]: value }));

  const createSequenceMutation = useCreateSequence();
  const {
    needsBillingSetup,
    showGate,
    gateProps,
    hasFalKey,
    hasOpenRouterKey,
    stripeEnabled,
  } = useBillingGate();

  const handleCancel = onCancel;

  const executeRegeneration = () => {
    posthog.capture('sequence_generated', {
      is_editing: isEditing,
      aspect_ratio: aspectRatio,
      image_models: imageModels,
      video_models: videoModels,
      audio_models: audioModels,
      auto_generate_motion: autoGenerateMotion,
      auto_generate_music: autoGenerateMusic,
      analysis_model_count: analysisModels.length,
      script_length: (script ?? sequence?.script ?? '').length,
    });
    createSequenceMutation.mutate(
      {
        title: undefined,
        teamId,
        script: script ?? sequence?.script ?? '',
        styleId: styleId || sequence?.styleId || undefined,
        aspectRatio,
        analysisModels,
        imageModels,
        videoModels,
        videoModel: videoModels[0] ?? DEFAULT_VIDEO_MODEL,
        autoGenerateMotion,
        autoGenerateMusic,
        musicModel: audioModels[0] ?? DEFAULT_MUSIC_MODEL,
        audioModels,
        suggestedTalentIds:
          selectedTalentIds.length > 0 ? selectedTalentIds : undefined,
        suggestedLocationIds:
          selectedLocationIds.length > 0 ? selectedLocationIds : undefined,
        elementUploads:
          draftElements.length > 0
            ? draftElements.map((el) => ({
                tempPath: el.tempPath,
                tempPublicUrl: el.tempPublicUrl,
                filename: el.filename,
                token: el.token,
                description: el.description,
                consistencyTag: el.consistencyTag,
              }))
            : undefined,
        sourceSequenceId: isEditing ? sequence.id : undefined,
      },
      {
        onSuccess: (result) => {
          clearDraft();
          if (onSuccess) {
            onSuccess(result.data.map((seq) => seq.id));
          }
        },
      }
    );
  };

  const handleSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
    if (event) {
      event.preventDefault();
    }

    if (needsBillingSetup) {
      showGate();
      return;
    }

    if (isEditing) {
      setEnhance('showRegenerateConfirm', true);
      return;
    }

    const scriptText = script ?? sequence?.script ?? '';
    if (!canUndoEnhance && scriptText.length < SCRIPT_SHORT_THRESHOLD) {
      setEnhance('showEnhanceNudge', true);
      return;
    }

    executeRegeneration();
  };

  const previousScriptRef = useRef<string>('');
  const enhanceAbortRef = useRef<AbortController | null>(null);

  const handleEnhance = async () => {
    if (needsBillingSetup) {
      showGate();
      return;
    }

    posthog.capture('script_enhanced', {
      target_duration: targetDuration,
      script_length: scriptValue.length,
      aspect_ratio: aspectRatio,
    });
    setEnhanceUI((s) => ({ ...s, isEnhancing: true, error: null }));
    previousScriptRef.current = scriptValue;
    setScript('');

    const abortController = new AbortController();
    enhanceAbortRef.current = abortController;

    try {
      const selectedStyle = styles.find((s) => s.id === styleId);
      let accumulated = '';
      for await (const chunk of await enhanceScriptStreamFn({
        data: {
          script: scriptValue,
          targetDuration,
          styleConfig: selectedStyle?.config ?? undefined,
          analysisModel: analysisModels[0],
          aspectRatio,
          elements:
            draftElements.length > 0
              ? draftElements.map((el) => ({
                  token: el.token,
                  imageUrl: el.tempPublicUrl,
                }))
              : undefined,
        },
      })) {
        if (abortController.signal.aborted) break;
        accumulated += chunk.delta;
        setScript(accumulated);
      }
      setEnhance('canUndoEnhance', true);
    } catch (error) {
      if (!abortController.signal.aborted) {
        setEnhance(
          'error',
          error instanceof Error ? error.message : 'Failed to enhance script'
        );
        setScript(previousScriptRef.current);
      }
    } finally {
      enhanceAbortRef.current = null;
      setEnhance('isEnhancing', false);
    }
  };

  const handleStopEnhance = () => {
    enhanceAbortRef.current?.abort();
  };

  const handleUndoEnhance = () => {
    setScript(previousScriptRef.current);
    setEnhance('canUndoEnhance', false);
  };

  useEffect(() => {
    if (!isEnhancing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.metaKey && e.key === '.')) {
        e.preventDefault();
        handleStopEnhance();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEnhancing]);

  const isFormValid =
    (script || sequence?.script) &&
    (styleId || sequence?.styleId) &&
    analysisModels.length > 0;

  const isSubmitting = createSequenceMutation.isPending;
  const isDisabled =
    !isFormValid || isSubmitting || isEnhancing || isElementBusy;

  const scriptValue = script ?? sequence?.script ?? '';
  const { ref: textareaRef } = useAutoScroll<HTMLDivElement>({
    enabled: isEnhancing,
    content: scriptValue,
  });

  return (
    <PremiumCard
      className={cn(
        'relative flex flex-col min-h-0 max-h-full',
        flat && 'border-none'
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDraggingFiles && (
        <div className="pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary/60 bg-background/80 backdrop-blur-sm">
          <ImagePlus className="size-10 text-primary" />
          <p className="text-base font-medium">
            Drop images to add as elements
          </p>
          <p className="text-xs text-muted-foreground">
            They'll be referenced by UPPERCASE tokens in your script
          </p>
        </div>
      )}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-col min-h-0 max-h-full"
      >
        {/* Control bar */}
        <CardHeader className="shrink-0 flex flex-col md:flex-row items-start justify-between gap-3 px-6 py-4 border-b border-border/50 bg-card/40">
          <GenerationSettings
            aspectRatio={aspectRatio}
            analysisModels={analysisModels}
            imageModels={imageModels}
            videoModels={videoModels}
            autoGenerateMotion={autoGenerateMotion}
            audioModels={audioModels}
            autoGenerateMusic={autoGenerateMusic}
            onAspectRatioChange={(v) => updateGen('aspectRatio', v)}
            onAnalysisModelsChange={(v) => updateGen('analysisModels', v)}
            onImageModelsChange={(v) => updateGen('imageModels', v)}
            onVideoModelsChange={(v) => updateGen('videoModels', v)}
            onAutoGenerateMotionChange={(v) =>
              updateGen('autoGenerateMotion', v)
            }
            onAudioModelsChange={(v) => updateGen('audioModels', v)}
            onAutoGenerateMusicChange={(v) => updateGen('autoGenerateMusic', v)}
            disabled={loading}
            styleCategory={styleCategory}
            styleName={styleName}
            recommendedImageModel={recommendedImageModel}
            recommendedVideoModel={recommendedVideoModel}
            recommendedAspectRatio={recommendedAspectRatio}
            appliedFromStyle={appliedFromStyle}
            onResetStyleDefaults={resetStyleDefaults}
          />
          <div className="flex items-center gap-2 min-h-10">
            <TalentSuggestionSelector
              selectedTalentIds={selectedTalentIds}
              onSelectionChange={(v) =>
                setSelections((s) => ({ ...s, talentIds: v }))
              }
              disabled={loading}
            />
            <LocationSuggestionSelector
              selectedLocationIds={selectedLocationIds}
              onSelectionChange={(v) =>
                setSelections((s) => ({ ...s, locationIds: v }))
              }
              disabled={loading}
            />
            {/* `isEditing = !!sequence?.id`; the `?.` mirrors that derivation for narrowing on `sequence.id` below. */}
            {/* oxlint-disable-next-line typescript/no-unnecessary-condition */}
            {isEditing && sequence?.id ? (
              <ElementSelector
                ref={elementSelectorRef}
                sequenceId={sequence.id}
                disabled={loading}
                onElementBusyChange={setIsElementBusy}
              />
            ) : (
              <ElementSelector
                ref={elementSelectorRef}
                draftElements={draftElements}
                onDraftElementsChange={setDraftElements}
                disabled={loading}
                onElementBusyChange={setIsElementBusy}
              />
            )}
          </div>
        </CardHeader>

        <CardContent className="min-h-0 @container flex flex-col gap-4 py-6 overflow-hidden">
          <div className="relative min-h-0 flex flex-col">
            <ScriptEditor
              ref={textareaRef}
              value={scriptValue}
              onValueChange={(val) => {
                setScript(val);
                if (canUndoEnhance) setEnhance('canUndoEnhance', false);
              }}
              maxLength={50000}
              placeholder="A one-liner or website URL is all you need — click Enhance Script to do the rest. Or paste a full screenplay and generate directly."
              disabled={loading}
              showCharacterCount={false}
            />
            <div className="absolute bottom-2 right-2 flex items-center gap-1">
              {canUndoEnhance && !isEnhancing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={handleUndoEnhance}
                >
                  <Undo2 className="size-3.5" />
                  Undo
                </Button>
              )}
              {isEnhancing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={handleStopEnhance}
                >
                  <span className="relative size-5">
                    <Loader2 className="absolute inset-0 size-5 animate-spin" />
                    <Square className="absolute inset-[5px] size-[10px] fill-current" />
                  </span>
                  Stop
                </Button>
              ) : (
                <Popover
                  open={enhancePopoverOpen}
                  onOpenChange={setEnhancePopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-muted-foreground"
                      disabled={
                        !scriptValue || scriptValue.length < 10 || isSubmitting
                      }
                    >
                      <Sparkles className="size-3.5" />
                      Enhance Script
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" side="top" className="w-auto">
                    <div className="flex flex-col gap-3">
                      <p className="text-sm font-medium">
                        Target video duration
                      </p>
                      <ToggleGroup
                        type="single"
                        value={String(targetDuration)}
                        onValueChange={(v) => {
                          if (v) setTargetDuration(Number(v));
                        }}
                        variant="outline"
                        size="sm"
                      >
                        {DURATION_PRESETS.map((preset) => (
                          <ToggleGroupItem
                            key={preset.value}
                            value={preset.value}
                          >
                            {preset.label}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          setEnhancePopoverOpen(false);
                          void handleEnhance();
                        }}
                      >
                        <Sparkles className="size-3.5" />
                        Enhance
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>
          {enhanceError && (
            <p className="text-sm text-destructive">{enhanceError}</p>
          )}

          <div className="shrink-0">
            <StyleSelector
              styles={styles}
              selectedStyleId={styleId || sequence?.styleId || null}
              onStyleSelect={setStyleId}
              loading={isLoadingStyles}
            />
          </div>
        </CardContent>

        <CardFooter className="shrink-0 flex-col gap-4 border-t border-border/30 bg-transparent px-6 py-4">
          {/* Footer row - stacks on mobile, inline on desktop */}
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Meta info - hidden on mobile */}
            <div className="hidden sm:flex items-center gap-4">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <span className="text-muted-foreground">+</span>
                  <Kbd>⏎</Kbd>
                </KbdGroup>
                <span className="ml-1">to generate</span>
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col items-stretch gap-1 w-full sm:w-auto">
              <div className="flex flex-row items-center gap-3 justify-end">
                {sequence?.id && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCancel}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={isDisabled}
                  className="group relative px-6 bg-linear-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground font-semibold tracking-wide shadow-lg shadow-primary/20 hover:shadow-primary/30 overflow-hidden"
                >
                  <span className="relative z-10 flex items-center justify-center gap-2">
                    {isSubmitting || isElementBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <GenerateSequenceIcon className="size-4" />
                    )}
                    {isSubmitting
                      ? 'Generating…'
                      : isElementBusy
                        ? 'Analyzing elements…'
                        : isEditing
                          ? 'Generate Copy'
                          : 'Generate'}
                  </span>
                  {/* Shine effect */}
                  <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700 pointer-events-none" />
                </Button>
              </div>
              <span className="hidden sm:block text-xs text-muted-foreground text-right">
                {isEditing
                  ? analysisModels.length === 1
                    ? '1 copy will be created'
                    : `${analysisModels.length} copies will be created`
                  : analysisModels.length === 1
                    ? '1 sequence will be created'
                    : `${analysisModels.length} sequences will be created`}
              </span>
            </div>
          </div>
        </CardFooter>
      </form>
      <BillingGateDialog
        {...gateProps}
        hasFalKey={hasFalKey}
        hasOpenRouterKey={hasOpenRouterKey}
        stripeEnabled={stripeEnabled}
      />
      <AlertDialog
        open={showRegenerateConfirm}
        onOpenChange={(v) => setEnhance('showRegenerateConfirm', v)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Generate a copy of this sequence?
            </AlertDialogTitle>
            <AlertDialogDescription>
              A copy will be created from this script. Your original sequence
              won't change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setEnhance('showRegenerateConfirm', false);
                executeRegeneration();
              }}
            >
              Generate Copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={showEnhanceNudge}
        onOpenChange={(v) => setEnhance('showEnhanceNudge', v)}
      >
        <AlertDialogContent
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              setEnhance('showEnhanceNudge', false);
              void handleEnhance();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Your script is just a starting point
            </AlertDialogTitle>
            <AlertDialogDescription>
              Short scripts produce simpler sequences. Enhance your script to
              create a detailed screenplay with visual descriptions, camera
              directions, and scene breakdowns — tailored to your selected
              style.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <p className="text-sm font-medium">Target video duration</p>
            <ToggleGroup
              type="single"
              value={String(targetDuration)}
              onValueChange={(v) => {
                if (v) setTargetDuration(Number(v));
              }}
              variant="outline"
              size="sm"
            >
              {DURATION_PRESETS.map((preset) => (
                <ToggleGroupItem key={preset.value} value={preset.value}>
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <div className="flex-1" />
            <AlertDialogAction
              className={buttonVariants({ variant: 'secondary' })}
              onClick={() => {
                setEnhance('showEnhanceNudge', false);
                executeRegeneration();
              }}
            >
              Generate As-Is
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setEnhance('showEnhanceNudge', false);
                void handleEnhance();
              }}
            >
              <Sparkles className="size-3.5" />
              Enhance Script
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PremiumCard>
  );
};
