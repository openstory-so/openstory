/**
 * Studio prompt bar (#1274). One card: reference tiles on the left, the
 * @-mention editor in the middle, a settings strip along the bottom.
 *
 * Video modes:
 *   - Text      — prompt only
 *   - Reference — stills attached as `@Image1`…`@ImageN`; typing `@` lists
 *                 what's attached plus the team library (picking a library
 *                 still attaches it)
 *   - Frames    — a start frame, plus an end frame where the model takes one
 */

import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { ActionCost } from '@/components/billing/action-cost';
import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { AspectRatioPills } from '@/components/settings/aspect-ratio-pills';
import { ResolutionPills } from '@/components/settings/resolution-pills';
import { IMAGE_MODELS } from '@/lib/ai/models';
import { imageResolutionTiers } from '@/lib/image/build-image-request';
import { motionResolutionTiers } from '@/lib/motion/build-model-input';
import {
  clampResolution,
  DEFAULT_RESOLUTION,
  RESOLUTION_OPTIONS,
  type Resolution,
} from '@/lib/constants/resolutions';
import {
  StudioReferencePicker,
  useStudioLibrary,
  type StudioReference,
} from '@/components/studio/studio-reference-picker';
import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
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
import { AppImage } from '@/components/ui/app-image';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import { useFalPricing } from '@/hooks/use-fal-pricing';
import {
  useCreateStudioAssets,
  useDraftStudioPrompt,
} from '@/hooks/use-studio-assets';
import { useUploadTempMedia } from '@/hooks/use-talent';
import {
  capReferenceImages,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getCompatibleModel,
  IMAGE_TO_VIDEO_MODELS,
  supportsReferenceImages,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  estimateImageCost,
  estimateStudioVideoCost,
} from '@/lib/billing/cost-estimation';
import { multiplyMicros } from '@/lib/billing/money';
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { isInsufficientCreditsError } from '@/lib/errors';
import { VoiceInputButton } from '@/components/voice/voice-input-button';
import { useEditorDictation } from '@/hooks/use-dictation';
import {
  pickShufflePrompt,
  studioShufflePrompts,
} from '@/lib/studio/prompt-shuffle';
import { parseStudioPaste } from '@/lib/studio/paste-import';
import type {
  StudioCreateInput,
  StudioReferenceKind,
} from '@/lib/studio/schema';
import {
  renumberStudioReferences,
  snapStudioVideoDuration,
  studioAudioLimit,
  studioCombinedRefCap,
  studioReferenceEndpoint,
  studioReferenceLimit,
  studioSupportsEndFrame,
  studioVideoRefLimit,
  studioSupportsMode,
  studioVideoDurations,
  studioVideoSupportsAudio,
  type StudioReferenceToken,
  type StudioVideoMode,
} from '@/lib/studio/text-to-video';
import {
  dataTransferHasImages,
  extractImagesFromSnapshot,
  snapshotDataTransfer,
  toastDragImportCorsError,
} from '@/lib/utils/drag-images';
import { cn } from '@/lib/utils';
import { usePostHog } from '@posthog/react';
import {
  ArrowUp,
  AudioLines,
  Film,
  ImagePlus,
  RotateCcw,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

const COUNTS = [1, 2, 4] as const;

const MODE_LABELS: Record<StudioVideoMode, string> = {
  text: 'Text to video',
  reference: 'Reference to video',
  frames: 'Image to video',
};

type PickerTarget = 'reference' | 'start' | 'end';

const REFERENCE_TOKENS = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
} as const satisfies Record<StudioReferenceKind, StudioReferenceToken>;

type StudioComposerProps = {
  activity: 'image' | 'video';
};

function referenceMentionItem(
  reference: StudioReference,
  index: number,
  kind: StudioReferenceToken = 'Image'
): MentionItem {
  const tag = `${kind}${index + 1}`;
  return {
    id: `ref:${kind}:${index}`,
    section: 'references',
    label: reference.label,
    sublabel: `@${tag}`,
    tag,
    haystack: `${tag} ${reference.label}`.toLowerCase(),
    thumbnailUrl:
      kind === 'Image'
        ? reference.url
        : kind === 'Video'
          ? reference.posterUrl
          : undefined,
  };
}

function Tile({
  reference,
  badge,
  onRemove,
  removeLabel = `Remove ${reference.label}`,
}: {
  reference: StudioReference;
  badge: string;
  onRemove: () => void;
  removeLabel?: string;
}) {
  return (
    <div
      className={cn(
        'group relative size-20 shrink-0 overflow-hidden rounded-lg border bg-muted',
        reference.kind === 'audio' &&
          'flex flex-col items-center justify-center gap-1 px-1'
      )}
    >
      {reference.kind === 'audio' ? (
        <>
          <AudioLines
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            className="w-full truncate text-center text-[10px]"
            title={reference.label}
          >
            {reference.label}
          </span>
        </>
      ) : reference.kind === 'video' ? (
        <video
          src={reference.url}
          poster={reference.posterUrl}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        >
          <track kind="captions" />
        </video>
      ) : (
        <AppImage
          src={reference.url}
          alt={reference.label}
          width={160}
          height={160}
          className="h-full w-full object-cover"
        />
      )}
      <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-background/85 px-1 font-mono text-[10px] leading-4">
        {reference.kind === 'video' && (
          <Film className="size-3" aria-hidden="true" />
        )}
        {badge}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="secondary"
        className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function AddTile({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hint ? `${label} (${hint})` : label}
      className="flex size-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ImagePlus className="size-4" aria-hidden="true" />
      {label}
      {hint && <span className="text-[10px] opacity-70">{hint}</span>}
    </button>
  );
}

export function StudioComposer({ activity }: StudioComposerProps) {
  const { requireAuth, isAuthenticated } = useAuthGate();
  const posthog = usePostHog();
  const { showGate } = useFalBillingGate();
  const { pricing } = useFalPricing();
  const create = useCreateStudioAssets();
  const draft = useDraftStudioPrompt();
  const upload = useUploadTempMedia();
  const library = useStudioLibrary();

  const [prompt, setPrompt] = useState('');
  const [imageModel, setImageModel] =
    useState<TextToImageModel>(DEFAULT_IMAGE_MODEL);
  const [videoModel, setVideoModel] =
    useState<ImageToVideoModel>(DEFAULT_VIDEO_MODEL);
  const [aspectRatio, setAspectRatio] =
    useState<AspectRatio>(DEFAULT_ASPECT_RATIO);
  const [pickedResolution, setResolution] =
    useState<Resolution>(DEFAULT_RESOLUTION);
  const [count, setCount] = useState<(typeof COUNTS)[number]>(1);
  const [duration, setDuration] = useState(5);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [lastShuffled, setLastShuffled] = useState<string | null>(null);
  // The mic sits in the toolbar next to Shuffle; dictation streams into the
  // prompt editor through this handle.
  const { ref: promptEditorRef, voice: promptVoice } = useEditorDictation();
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [emptyPrompt, setEmptyPrompt] = useState(false);

  // Reference is the default: it is what the tiles, @ list and picker are for.
  const [mode, setMode] = useState<StudioVideoMode>('reference');
  const [references, setReferences] = useState<StudioReference[]>([]);
  const [videoRefs, setVideoRefs] = useState<StudioReference[]>([]);
  const [audioRefs, setAudioRefs] = useState<StudioReference[]>([]);
  const [startFrame, setStartFrame] = useState<StudioReference | null>(null);
  const [endFrame, setEndFrame] = useState<StudioReference | null>(null);
  const [uploading, setUploading] = useState(0);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const isVideo = activity === 'video';
  const compatibleVideoModel = getCompatibleModel(videoModel, aspectRatio);
  // Only the tiers this model serves get a pill, so the stored pick is clamped
  // to them rather than left pointing at a pill that is no longer there.
  const activeModelName = isVideo
    ? IMAGE_TO_VIDEO_MODELS[compatibleVideoModel].name
    : IMAGE_MODELS[imageModel].name;
  const resolutionTiers = isVideo
    ? motionResolutionTiers(compatibleVideoModel)
    : imageResolutionTiers(imageModel, aspectRatio);
  const resolution = clampResolution(pickedResolution, resolutionTiers);
  const resolutionNote =
    resolutionTiers.length === 0
      ? `${activeModelName} renders at a fixed size`
      : null;
  const snappedDuration = snapStudioVideoDuration(
    duration,
    compatibleVideoModel
  );
  const audioCapable = studioVideoSupportsAudio(compatibleVideoModel);
  const durationCapable = studioVideoDurations(compatibleVideoModel).length > 0;
  // Images: the model's edit endpoint takes stills (no clips/audio). Models
  // without a per-endpoint cap get the schema's cap of 9.
  const imageRefLimit = supportsReferenceImages(imageModel)
    ? capReferenceImages(imageModel, Array.from({ length: 9 })).length
    : 0;
  const referenceLimit = isVideo
    ? studioReferenceLimit(compatibleVideoModel)
    : imageRefLimit;
  const videoRefLimit = isVideo ? studioVideoRefLimit(compatibleVideoModel) : 0;
  const audioLimit = isVideo ? studioAudioLimit(compatibleVideoModel) : 0;
  const combinedRefCap = isVideo
    ? studioCombinedRefCap(compatibleVideoModel)
    : null;
  /** Whether this composer can attach anything at all. */
  const refsCapable = isVideo || imageRefLimit > 0;
  const endFrameCapable = studioSupportsEndFrame(compatibleVideoModel);
  // Reference mode with nothing attached submits as text, so the default
  // mode never dead-ends a plain prompt.
  const effectiveMode: StudioVideoMode = !isVideo
    ? 'text'
    : mode === 'reference' && references.length + videoRefs.length === 0
      ? 'text'
      : mode;

  const estimate = useMemo(() => {
    if (!pricing) return null;
    if (activity === 'image') {
      const still = estimateImageCost(imageModel, aspectRatio, 1, {
        pricing,
        resolution,
        edit: references.length > 0,
      });
      return still === null ? null : multiplyMicros(still, count);
    }
    const motion = estimateStudioVideoCost(
      compatibleVideoModel,
      snappedDuration,
      { pricing, mode: effectiveMode, resolution }
    );
    return motion === null ? null : multiplyMicros(motion, count);
  }, [
    activity,
    aspectRatio,
    compatibleVideoModel,
    count,
    effectiveMode,
    imageModel,
    pricing,
    references.length,
    resolution,
    snappedDuration,
  ]);

  const trimmed = prompt.trim();
  const modeReady =
    effectiveMode === 'text' ||
    (effectiveMode === 'reference' &&
      references.length + videoRefs.length > 0) ||
    (effectiveMode === 'frames' && startFrame !== null);
  // Generate stays live on an empty prompt (#1393) — an empty click is the
  // cheapest place to open the login dialog or offer a random prompt. Only
  // an unready mode or an in-flight upload actually disables it.
  const canSubmit = modeReady && uploading === 0;

  // --- references -----------------------------------------------------------

  const limits: Record<StudioReferenceKind, number> = {
    image: referenceLimit,
    video: videoRefLimit,
    audio: audioLimit,
  };
  const counts: Record<StudioReferenceKind, number> = {
    image: references.length,
    video: videoRefs.length,
    audio: audioRefs.length,
  };
  const setListFor = {
    image: setReferences,
    video: setVideoRefs,
    audio: setAudioRefs,
  };
  const slots = useMemo<Record<StudioReferenceKind, number>>(() => {
    const used = references.length + videoRefs.length + audioRefs.length;
    const combinedRemaining =
      combinedRefCap == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, combinedRefCap - used);
    return {
      image: Math.min(
        Math.max(0, referenceLimit - references.length),
        combinedRemaining
      ),
      video: Math.min(
        Math.max(0, videoRefLimit - videoRefs.length),
        combinedRemaining
      ),
      audio: Math.min(
        Math.max(0, audioLimit - audioRefs.length),
        combinedRemaining
      ),
    };
  }, [
    audioLimit,
    audioRefs.length,
    combinedRefCap,
    referenceLimit,
    references.length,
    videoRefLimit,
    videoRefs.length,
  ]);

  /** Append to the list for its kind; returns the new index, or -1 at cap. */
  const addReference = (reference: StudioReference): number => {
    const { kind } = reference;
    const index = counts[kind];
    if (index >= limits[kind]) {
      toast.error(`Up to ${limits[kind]} reference ${kind}s`);
      return -1;
    }
    const used = counts.image + counts.video + counts.audio;
    if (combinedRefCap != null && used >= combinedRefCap) {
      toast.error(`Up to ${combinedRefCap} reference files total`);
      return -1;
    }
    setListFor[kind]((prev) => [...prev, reference]);
    if (isVideo && mode !== 'reference') setMode('reference');
    return index;
  };

  const removeReference = (kind: StudioReferenceKind, index: number) => {
    setListFor[kind]((prev) => prev.filter((_, i) => i !== index));
    setPrompt((prev) =>
      renumberStudioReferences(prev, index, REFERENCE_TOKENS[kind])
    );
  };

  const placeReference = (reference: StudioReference, target: PickerTarget) => {
    if (target === 'start') setStartFrame(reference);
    else if (target === 'end') setEndFrame(reference);
    else addReference(reference);
  };

  const dropTarget = (): PickerTarget => {
    if (mode !== 'frames') return 'reference';
    if (!startFrame) return 'start';
    return endFrameCapable ? 'end' : 'start';
  };

  const fileKind = (file: File): StudioReferenceKind | null =>
    file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : file.type.startsWith('audio/')
          ? 'audio'
          : null;

  const uploadFiles = async (files: File[], target: PickerTarget) => {
    const taken: Record<StudioReferenceKind, number> = {
      image: 0,
      video: 0,
      audio: 0,
    };
    for (const file of files) {
      const kind = fileKind(file);
      if (!kind) continue;
      if (target !== 'reference' && kind !== 'image') continue;
      const room = target === 'reference' ? slots[kind] : 1;
      if (taken[kind] >= room) {
        toast.error(
          target === 'reference'
            ? `Up to ${limits[kind]} reference ${kind}s`
            : 'One image per frame'
        );
        continue;
      }
      taken[kind] += 1;
      setUploading((n) => n + 1);
      try {
        const { url } = await upload.mutateAsync({
          file,
          type: kind === 'audio' ? 'recording' : kind,
        });
        placeReference({ url, label: file.name, kind }, target);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Upload failed');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onDrop = (event: React.DragEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!refsCapable || !dataTransferHasImages(event.dataTransfer)) return;
    const snapshot = snapshotDataTransfer(event.dataTransfer);
    const target = dropTarget();
    void extractImagesFromSnapshot(snapshot).then(({ files, failedUrls }) => {
      if (failedUrls.length > 0) toastDragImportCorsError();
      if (files.length > 0) void uploadFiles(files, target);
    });
  };

  // --- @ mentions -----------------------------------------------------------

  const mentionItems = useMemo<MentionItem[]>(() => {
    if (!refsCapable || effectiveMode === 'frames') return [];
    const items = [
      ...references.map((r, i) => referenceMentionItem(r, i)),
      ...videoRefs.map((r, i) => referenceMentionItem(r, i, 'Video')),
      ...audioRefs.map((r, i) => referenceMentionItem(r, i, 'Audio')),
    ];
    const libraryItem = (
      section: 'images' | 'cast' | 'locations',
      reference: StudioReference
    ): MentionItem => ({
      id: `${section}:${reference.kind}:${reference.url}`,
      section,
      label: reference.label,
      sublabel:
        reference.kind === 'video'
          ? `Attach as @Video${videoRefs.length + 1}`
          : `Attach as @Image${references.length + 1}`,
      // Never in the prompt — a library row only ever reaches it via
      // `onMentionSelect`, which swaps it for the attached `ImageN`. An
      // empty tag is skipped by the matcher.
      tag: '',
      haystack: reference.label.toLowerCase(),
      thumbnailUrl:
        reference.kind === 'video' ? reference.posterUrl : reference.url,
    });
    return [
      ...items,
      ...library.cast.map((r) => libraryItem('cast', r)),
      ...library.locations.map((r) => libraryItem('locations', r)),
      ...library.generations
        .filter((r) => slots[r.kind] > 0)
        .map((r) => libraryItem('images', r)),
    ];
  }, [
    audioRefs,
    effectiveMode,
    library,
    references,
    refsCapable,
    slots,
    videoRefs,
  ]);

  const onMentionSelect = (item: MentionItem): MentionItem => {
    if (item.section === 'references') return item;
    const [, kind = 'image', ...rest] = item.id.split(':');
    const url = rest.join(':');
    const reference: StudioReference = {
      url,
      label: item.label,
      kind: kind === 'video' ? 'video' : 'image',
      posterUrl:
        kind === 'video' ? (item.thumbnailUrl ?? undefined) : undefined,
    };
    const index = addReference(reference);
    if (index < 0) return item;
    return referenceMentionItem(
      reference,
      index,
      reference.kind === 'video' ? 'Video' : 'Image'
    );
  };

  // --- settings -------------------------------------------------------------

  const changeVideoModel = (next: ImageToVideoModel) => {
    setVideoModel(next);
    if (!studioSupportsMode(next, mode)) setMode('text');
    if (!studioSupportsEndFrame(next)) setEndFrame(null);
    if (studioAudioLimit(next) === 0) setAudioRefs([]);
    if (studioVideoRefLimit(next) === 0) setVideoRefs([]);
  };

  const applyShuffle = () => {
    const next = pickShufflePrompt(
      studioShufflePrompts(activity),
      prompt,
      Math.random
    );
    if (!next) return;
    setPrompt(next);
    setLastShuffled(next);
  };

  const requestShuffle = () => {
    if (trimmed.length > 0 && trimmed !== lastShuffled) {
      setReplaceConfirm(true);
      return;
    }
    applyShuffle();
  };

  const draftSources = [...references, ...videoRefs, ...audioRefs];
  const canDraft =
    (effectiveMode === 'reference' && draftSources.length > 0) ||
    (effectiveMode === 'frames' && startFrame !== null);

  const applyDraft = (options?: {
    /** Intent to write from when the composer is empty. */
    seed?: string;
    onDrafted?: (next: string) => void;
  }) => {
    draft.mutate(
      {
        activity,
        references:
          effectiveMode === 'reference'
            ? draftSources.map(({ url, label, kind }) => ({ url, label, kind }))
            : [],
        startImageUrl: mode === 'frames' ? startFrame?.url : undefined,
        endImageUrl: mode === 'frames' ? endFrame?.url : undefined,
        currentPrompt: trimmed || options?.seed,
      },
      {
        onSuccess: ({ prompt: next }) => {
          setPrompt(next);
          setLastShuffled(next);
          options?.onDrafted?.(next);
        },
        onError: (error) => {
          if (isInsufficientCreditsError(error)) showGate();
        },
      }
    );
  };

  /**
   * "Try something random": the draft flow invents the prompt — from whatever
   * is attached, or from nothing at all. Deliberately NOT seeded from the
   * Shuffle pool: those are the canned tour prompts, and reusing one here
   * would hand every "random" user the same dozen shots.
   *
   * It stops there. The prompt lands in the composer for the user to read and
   * edit before they spend anything on generating it.
   */
  const generateRandom = () => {
    posthog.capture('empty_prompt_choice', {
      surface: 'studio',
      activity,
      choice: 'random',
    });
    applyDraft({ onDrafted: () => setEmptyPrompt(false) });
  };

  /**
   * Pasting a file attaches it; pasting a scene's request JSON (from the
   * optimised prompt panel) rebuilds the references + prompt instead of
   * dumping JSON into the editor. Capture phase + stopPropagation so
   * ProseMirror never sees either.
   */
  const onPasteCapture = (event: React.ClipboardEvent) => {
    // Pasted files (a screenshot, a clip) attach straight away. The picker is
    // a portal, so its pastes bubble through here too — route them to the
    // tile whose picker is open.
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      if (!refsCapable) return;
      event.preventDefault();
      event.stopPropagation();
      const target = picker && picker !== 'reference' ? picker : dropTarget();
      void uploadFiles(files, target);
      setPicker(null);
      return;
    }
    if (!isVideo) return;
    const imported = parseStudioPaste(
      event.clipboardData.getData('text/plain')
    );
    if (!imported) return;
    event.preventDefault();
    event.stopPropagation();
    const label = (kind: string, i: number) => `Pasted ${kind} ${i + 1}`;
    if (imported.startImageUrl) {
      setMode('frames');
      setStartFrame({
        url: imported.startImageUrl,
        label: 'Pasted start frame',
        kind: 'image',
      });
      setEndFrame(
        imported.endImageUrl && endFrameCapable
          ? {
              url: imported.endImageUrl,
              label: 'Pasted end frame',
              kind: 'image',
            }
          : null
      );
    } else {
      setMode('reference');
      setReferences(
        imported.images
          .slice(0, referenceLimit)
          .map((url, i) => ({ url, label: label('image', i), kind: 'image' }))
      );
      setVideoRefs(
        imported.videos
          .slice(0, videoRefLimit)
          .map((url, i) => ({ url, label: label('clip', i), kind: 'video' }))
      );
      setAudioRefs(
        imported.audio
          .slice(0, audioLimit)
          .map((url, i) => ({ url, label: label('audio', i), kind: 'audio' }))
      );
    }
    setPrompt(imported.prompt);
    setLastShuffled(imported.prompt);
    const requested =
      imported.images.length +
      imported.videos.length +
      imported.audio.length +
      (imported.startImageUrl ? 1 : 0) +
      (imported.endImageUrl ? 1 : 0);
    const total = imported.startImageUrl
      ? 1 + (imported.endImageUrl && endFrameCapable ? 1 : 0)
      : Math.min(imported.images.length, referenceLimit) +
        Math.min(imported.videos.length, videoRefLimit) +
        Math.min(imported.audio.length, audioLimit);
    const dropped = requested - total;
    toast.success(
      total > 0
        ? `Imported the prompt and ${total} reference${total === 1 ? '' : 's'}` +
            (dropped > 0 ? ` (${dropped} over the model's limit dropped)` : '')
        : 'Imported the prompt'
    );
  };

  const clearAll = () => {
    setPrompt('');
    setReferences([]);
    setVideoRefs([]);
    setAudioRefs([]);
    setStartFrame(null);
    setEndFrame(null);
  };

  const buildInput = (): StudioCreateInput => {
    if (activity === 'video') {
      return {
        activity: 'video',
        prompt: trimmed,
        videoModel: compatibleVideoModel,
        aspectRatio,
        resolution,
        duration: snappedDuration,
        count,
        generateAudio: audioCapable ? generateAudio : undefined,
        mode: effectiveMode,
        referenceImages:
          effectiveMode === 'reference' ? references.map((r) => r.url) : [],
        referenceVideos:
          effectiveMode === 'reference' ? videoRefs.map((r) => r.url) : [],
        referenceAudio:
          effectiveMode === 'reference' ? audioRefs.map((r) => r.url) : [],
        startImageUrl: effectiveMode === 'frames' ? startFrame?.url : undefined,
        endImageUrl: effectiveMode === 'frames' ? endFrame?.url : undefined,
      };
    }
    return {
      activity: 'image',
      prompt: trimmed,
      imageModel,
      aspectRatio,
      resolution,
      count,
      referenceImages: references.map((r) => r.url),
    };
  };

  const submit = () => {
    if (!canSubmit) return;
    if (trimmed.length === 0) {
      posthog.capture('empty_prompt_generate_clicked', {
        surface: 'studio',
        activity,
        authenticated: isAuthenticated,
      });
      // Logged out: the login dialog is the ask. Logged in: pick a prompt.
      if (requireAuth()) setEmptyPrompt(true);
      return;
    }
    requireAuth(() => {
      create.mutate(buildInput(), {
        onError: (error) => {
          if (isInsufficientCreditsError(error)) showGate();
        },
      });
    });
  };

  const submitLabel =
    activity === 'video'
      ? count > 1
        ? `Generate ${count} videos`
        : 'Generate video'
      : count > 1
        ? `Generate ${count} images`
        : 'Generate image';

  const placeholder =
    effectiveMode === 'reference'
      ? 'Describe the shot. Type @ to reference an attached image…'
      : effectiveMode === 'frames'
        ? 'Describe how the start frame moves…'
        : activity === 'video'
          ? 'A red fox turns toward camera in morning fog…'
          : imageRefLimit > 0
            ? 'Describe the still. Type @ to reference an attached image…'
            : 'A red fox in fog at dawn, cinematic lighting…';

  const aspect = ASPECT_RATIOS.find((r) => r.value === aspectRatio);
  const summary = [
    aspectRatio,
    resolutionTiers.length > 0
      ? RESOLUTION_OPTIONS.find((r) => r.value === resolution)?.label
      : null,
    isVideo && durationCapable ? `${snappedDuration}s` : null,
    isVideo && audioCapable ? (generateAudio ? 'Audio' : 'Silent') : null,
    `×${count}`,
  ].filter(Boolean);

  const showTiles = isVideo ? mode !== 'text' : imageRefLimit > 0;
  const hasContent =
    trimmed.length > 0 ||
    references.length > 0 ||
    videoRefs.length > 0 ||
    audioRefs.length > 0 ||
    startFrame !== null ||
    endFrame !== null;

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop zone; the Add tile is the keyboard path
    <form
      className={cn(
        'relative flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm',
        dragging && 'border-ring ring-3 ring-ring/30'
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragEnter={(event) => {
        if (!refsCapable || !dataTransferHasImages(event.dataTransfer)) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(event) => {
        if (refsCapable && dataTransferHasImages(event.dataTransfer)) {
          event.preventDefault();
        }
      }}
      onDrop={onDrop}
      onPasteCapture={onPasteCapture}
    >
      <div className="flex flex-col gap-3 md:flex-row">
        {showTiles && (
          <div
            className="flex shrink-0 gap-2 overflow-x-auto md:max-w-[19rem] md:flex-wrap"
            aria-label={
              mode === 'frames' ? 'Start and end frames' : 'Reference images'
            }
          >
            {(isVideo ? mode === 'reference' : true) && (
              <>
                {references.map((reference, index) => (
                  <Tile
                    key={`${reference.url}-${index}`}
                    reference={reference}
                    badge={`@Image${index + 1}`}
                    onRemove={() => removeReference('image', index)}
                  />
                ))}
                {videoRefs.map((reference, index) => (
                  <Tile
                    key={`${reference.url}-${index}`}
                    reference={reference}
                    badge={`@Video${index + 1}`}
                    onRemove={() => removeReference('video', index)}
                  />
                ))}
                {audioRefs.map((reference, index) => (
                  <Tile
                    key={`${reference.url}-${index}`}
                    reference={reference}
                    badge={`@Audio${index + 1}`}
                    onRemove={() => removeReference('audio', index)}
                  />
                ))}
                {slots.image + slots.video + slots.audio > uploading && (
                  <AddTile
                    label="Reference"
                    onClick={() => setPicker('reference')}
                  />
                )}
              </>
            )}
            {mode === 'frames' && (
              <>
                {startFrame ? (
                  <Tile
                    reference={startFrame}
                    badge="Start"
                    removeLabel="Remove start frame"
                    onRemove={() => setStartFrame(null)}
                  />
                ) : (
                  <AddTile
                    label="Start frame"
                    onClick={() => setPicker('start')}
                  />
                )}
                {endFrameCapable &&
                  (endFrame ? (
                    <Tile
                      reference={endFrame}
                      badge="End"
                      removeLabel="Remove end frame"
                      onRemove={() => setEndFrame(null)}
                    />
                  ) : (
                    <AddTile
                      label="End frame"
                      hint="optional"
                      onClick={() => setPicker('end')}
                    />
                  ))}
              </>
            )}
            {Array.from({ length: uploading }, (_, i) => (
              <Skeleton key={i} className="size-20 shrink-0 rounded-lg" />
            ))}
          </div>
        )}

        <MarkdownEditor
          value={prompt}
          onValueChange={setPrompt}
          ref={promptEditorRef}
          placeholder={placeholder}
          aria-label="Prompt"
          data-testid="studio-prompt"
          className="min-h-24 flex-1 border-0 bg-transparent px-1 py-1 shadow-none focus-within:ring-0 dark:bg-transparent"
          mentionItems={refsCapable ? mentionItems : undefined}
          onMentionSelect={onMentionSelect}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              submit();
              return true;
            }
            return false;
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isVideo && (
          <Select
            value={mode}
            onValueChange={(value) => {
              if (
                value === 'text' ||
                value === 'reference' ||
                value === 'frames'
              ) {
                setMode(value);
              }
            }}
          >
            <SelectTrigger aria-label="Video mode" className="w-auto gap-1.5">
              <SelectValue>{MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(['text', 'reference', 'frames'] as const).map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  disabled={!studioSupportsMode(compatibleVideoModel, value)}
                >
                  {MODE_LABELS[value]}
                  {value === 'reference' &&
                    !studioSupportsMode(compatibleVideoModel, value) && (
                      <span className="text-muted-foreground">
                        {' '}
                        · not on this model
                      </span>
                    )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label="Generation settings"
              className="gap-2"
            >
              {aspect && (
                <AspectRatioIcon
                  width={aspect.width}
                  height={aspect.height}
                  size="sm"
                />
              )}
              <span className="font-mono text-xs">{summary.join(' · ')}</span>
              <SlidersHorizontal className="size-3.5 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={12}
            className="w-[min(22rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-x-hidden p-4"
          >
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Model</h3>
                {activity === 'image' ? (
                  <ImageModelSelector
                    selectedModel={imageModel}
                    onModelChange={(next) => {
                      setImageModel(next);
                      if (!supportsReferenceImages(next)) setReferences([]);
                    }}
                  />
                ) : (
                  <MotionModelSelector
                    selectedModel={compatibleVideoModel}
                    onModelChange={changeVideoModel}
                    aspectRatio={aspectRatio}
                  />
                )}
                {isVideo && referenceLimit === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {IMAGE_TO_VIDEO_MODELS[compatibleVideoModel].name} takes
                    frames, not reference images.
                  </p>
                )}
                {isVideo &&
                  studioReferenceEndpoint(compatibleVideoModel)?.note && (
                    <p className="text-xs text-muted-foreground">
                      {studioReferenceEndpoint(compatibleVideoModel)?.note}
                    </p>
                  )}
                {!isVideo && imageRefLimit === 0 && (
                  <p className="text-xs text-muted-foreground">
                    This model has no edit endpoint, so it cannot take reference
                    images.
                  </p>
                )}
              </section>
              <Separator />
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Aspect ratio</h3>
                <AspectRatioPills
                  value={aspectRatio}
                  onChange={setAspectRatio}
                />
              </section>
              <Separator />
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Resolution</h3>
                <ResolutionPills
                  value={resolution}
                  onChange={setResolution}
                  available={resolutionTiers}
                  note={resolutionNote}
                />
              </section>
              {isVideo && durationCapable && (
                <>
                  <Separator />
                  <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">Duration</h3>
                    <ToggleGroup
                      type="single"
                      value={String(snappedDuration)}
                      onValueChange={(value) => {
                        const next = Number(value);
                        if (Number.isFinite(next) && next > 0)
                          setDuration(next);
                      }}
                      variant="outline"
                      spacing={0}
                      className="flex-wrap"
                      aria-label="Clip duration"
                    >
                      {studioVideoDurations(compatibleVideoModel).map(
                        (value) => (
                          <ToggleGroupItem
                            key={value}
                            value={String(value)}
                            className="px-3 font-mono text-xs"
                          >
                            {value}s
                          </ToggleGroupItem>
                        )
                      )}
                    </ToggleGroup>
                  </section>
                </>
              )}
              {isVideo && audioCapable && (
                <>
                  <Separator />
                  <section className="flex items-center justify-between gap-4">
                    <label
                      htmlFor="studio-generate-audio"
                      className="text-sm font-medium"
                    >
                      Native audio
                    </label>
                    <Switch
                      id="studio-generate-audio"
                      checked={generateAudio}
                      onCheckedChange={setGenerateAudio}
                    />
                  </section>
                </>
              )}
              <Separator />
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Count</h3>
                <ToggleGroup
                  type="single"
                  value={String(count)}
                  onValueChange={(value) => {
                    const next = Number(value);
                    if (next === 1 || next === 2 || next === 4) setCount(next);
                  }}
                  variant="outline"
                  spacing={0}
                  aria-label="How many to generate"
                >
                  {COUNTS.map((value) => (
                    <ToggleGroupItem
                      key={value}
                      value={String(value)}
                      className="px-3 font-mono text-xs"
                    >
                      {value}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </section>
            </div>
          </PopoverContent>
        </Popover>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={requestShuffle}
        >
          <Shuffle className="size-3.5" aria-hidden="true" />
          Shuffle
        </Button>
        {canDraft && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => applyDraft()}
            disabled={draft.isPending}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            {draft.isPending ? 'Drafting…' : 'Draft prompt'}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {hasContent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={clearAll}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Clear all
            </Button>
          )}
          <ActionCost estimate={estimate} align="end" />
          <VoiceInputButton label="prompt" {...promptVoice} />
          <Button
            type="submit"
            size="icon-lg"
            className="rounded-full"
            aria-label={submitLabel}
            disabled={!canSubmit}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/80 text-sm font-medium">
          Drop to add{' '}
          {dropTarget() === 'reference' ? 'reference' : `${dropTarget()} frame`}
        </div>
      )}

      <StudioReferencePicker
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
        title={
          picker === 'start'
            ? 'Start frame'
            : picker === 'end'
              ? 'End frame'
              : 'Add reference'
        }
        library={library}
        attached={
          picker === 'reference'
            ? [...references, ...videoRefs, ...audioRefs].map((r) => r.url)
            : [startFrame?.url, endFrame?.url].filter((url): url is string =>
                Boolean(url)
              )
        }
        multiple={picker === 'reference'}
        slots={
          picker === 'reference' ? slots : { image: 1, video: 0, audio: 0 }
        }
        onPick={(picked) => {
          if (!picker) return;
          if (picker === 'reference') {
            for (const reference of picked) addReference(reference);
          } else {
            const first = picked[0];
            if (first) placeReference(first, picker);
          }
        }}
        onUpload={(files) => {
          if (picker) void uploadFiles(files, picker);
        }}
      />

      <AlertDialog open={emptyPrompt} onOpenChange={setEmptyPrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>What should we make?</AlertDialogTitle>
            <AlertDialogDescription>
              The prompt is empty. Describe the {isVideo ? 'shot' : 'still'} you
              want, or we'll write one for you to look over.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() =>
                posthog.capture('empty_prompt_choice', {
                  surface: 'studio',
                  activity,
                  choice: 'own_prompt',
                })
              }
            >
              I'll write it
            </AlertDialogCancel>
            <AlertDialogAction
              // Keep the dialog up while the draft streams — closing on click
              // would leave the click with no visible effect for a second or two.
              onClick={(event) => {
                event.preventDefault();
                generateRandom();
              }}
              disabled={draft.isPending}
            >
              <Sparkles className="size-3.5" />
              {draft.isPending ? 'Writing a prompt…' : 'Try something random'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={replaceConfirm} onOpenChange={setReplaceConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              Shuffle swaps in a sample prompt. What you've written here will be
              replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my prompt</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setReplaceConfirm(false);
                applyShuffle();
              }}
            >
              <Shuffle className="size-3.5" />
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
