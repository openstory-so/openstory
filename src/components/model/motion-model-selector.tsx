import {
  BaseModelSelector,
  type ModelGenerationStatus,
} from './base-model-selector';
import {
  IMAGE_TO_VIDEO_MODELS,
  isModelCompatibleWithAspectRatio,
  isValidImageToVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import {
  compareSelectorModels,
  QUALITY_DEFAULT_VIDEO,
  SELECTOR_GROUP_ORDER,
  selectorGroup,
  TURBO_VIDEO_MODELS,
} from '@/lib/ai/generation-mode';
import { useViaAvailability } from '@/hooks/use-via-availability';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { useMemo } from 'react';

type MotionModelFilterProps = {
  aspectRatio?: AspectRatio;
  /** When set, models with a matching `requiredStyleCategory` are included */
  styleCategory?: string;
  /** Style-recommended model key — renders a "Recommended" badge on the match. */
  recommendedVideoModel?: string | null;
  /** Style name, used in the recommendation tooltip. */
  styleName?: string;
  /** When set, only these keys appear (Turbo mode). */
  allowedIds?: readonly ImageToVideoModel[];
  /**
   * Reference-only mode: narrow the list to models that can render without a
   * start frame. Filtering the options is what keeps the mode from failing at
   * submit — the create schema rejects an incompatible selection, and a user
   * should never be able to build one.
   */
  referenceOnly?: boolean;
  /**
   * Never filter this key out. The shot's current model: hiding it would leave
   * the trigger reading "Unknown", so it stays listed and the panel says why
   * it cannot render. Only an ALREADY-chosen model is exempt — the list still
   * offers no other model the mode cannot use.
   */
  keepId?: ImageToVideoModel;
};

/**
 * Build the filtered, sorted motion-model option list. Shared by the single-
 * and multi-select variants so aspect-ratio compatibility, style-category
 * gating, and the recommendation badge behave identically across both.
 */
function useMotionModels({
  aspectRatio,
  styleCategory,
  recommendedVideoModel,
  styleName,
  allowedIds,
  referenceOnly,
  keepId,
}: MotionModelFilterProps) {
  // Resolved server-side per team and seeded by the `_app` route loader, so the
  // list is right on first paint. Grok Imagine appears here only where an xAI
  // key resolves — on fal its id is an image-to-video endpoint.
  const { referenceOnlyModels } = useViaAvailability();
  return useMemo(
    () =>
      Object.entries(IMAGE_TO_VIDEO_MODELS)
        .filter(([key, m]) => {
          if (!isValidImageToVideoModel(key)) return false;
          if ('hidden' in m) return false;
          if (allowedIds && !allowedIds.includes(key)) return false;
          if (
            referenceOnly &&
            key !== keepId &&
            !referenceOnlyModels.includes(key)
          )
            return false;
          if (
            'requiredStyleCategory' in m &&
            m.requiredStyleCategory !== styleCategory
          )
            return false;
          return aspectRatio
            ? isModelCompatibleWithAspectRatio(key, aspectRatio)
            : true;
        })
        .sort(([a], [b]) =>
          compareSelectorModels(
            a,
            b,
            TURBO_VIDEO_MODELS,
            QUALITY_DEFAULT_VIDEO,
            (id) =>
              isValidImageToVideoModel(id)
                ? IMAGE_TO_VIDEO_MODELS[id].qualityRank
                : 99
          )
        )
        .map(([key, m]) => {
          const isRecommended = key === recommendedVideoModel;
          const recommendedFor = isRecommended
            ? styleName
              ? `Recommended for ${styleName}`
              : 'Recommended for this style'
            : undefined;
          return {
            id: key,
            name: m.name,
            group: selectorGroup(key, TURBO_VIDEO_MODELS),
            badge: m.license,
            recommendedFor,
          };
        }),
    [
      aspectRatio,
      styleCategory,
      recommendedVideoModel,
      styleName,
      allowedIds,
      referenceOnly,
      keepId,
      referenceOnlyModels,
    ]
  );
}

function useRecommendationStatus(
  recommendedVideoModel: string | null | undefined,
  aspectRatio: AspectRatio | undefined,
  allowedIds?: readonly ImageToVideoModel[]
): 'matched' | 'incompatible-ratio' | 'hidden-by-filter' | 'unknown' | 'none' {
  return useMemo(() => {
    if (!recommendedVideoModel) return 'none';
    if (!isValidImageToVideoModel(recommendedVideoModel)) return 'unknown';
    if (
      aspectRatio &&
      !isModelCompatibleWithAspectRatio(recommendedVideoModel, aspectRatio)
    ) {
      return 'incompatible-ratio';
    }
    if (allowedIds && !allowedIds.includes(recommendedVideoModel)) {
      return 'hidden-by-filter';
    }
    return 'matched';
  }, [recommendedVideoModel, aspectRatio, allowedIds]);
}

function RecommendationHint({
  status,
  recommendedVideoModel,
  styleName,
}: {
  status:
    | 'matched'
    | 'incompatible-ratio'
    | 'hidden-by-filter'
    | 'unknown'
    | 'none';
  recommendedVideoModel: string | null | undefined;
  styleName: string | undefined;
}) {
  const recommendedModelName =
    recommendedVideoModel && isValidImageToVideoModel(recommendedVideoModel)
      ? IMAGE_TO_VIDEO_MODELS[recommendedVideoModel].name
      : undefined;

  if (status === 'incompatible-ratio' && recommendedModelName) {
    return (
      <p className="text-[10px] text-muted-foreground">
        {styleName ? `${styleName} recommends` : 'Recommended'}{' '}
        <span className="font-medium">{recommendedModelName}</span>, but it's
        not compatible with the current aspect ratio.
      </p>
    );
  }
  if (status === 'unknown') {
    return (
      <p className="text-[10px] text-muted-foreground">
        {styleName ? `${styleName} recommends` : 'Recommended'} a model that's
        no longer available.
      </p>
    );
  }
  if (status === 'hidden-by-filter' && recommendedModelName) {
    return (
      <p className="text-[10px] text-muted-foreground">
        {styleName ? `${styleName} recommends` : 'Recommended'}{' '}
        <span className="font-medium">{recommendedModelName}</span>, but it's
        not available in this selector.
      </p>
    );
  }
  return null;
}

type MotionModelSelectorProps = {
  selectedModel: ImageToVideoModel;
  onModelChange: (model: ImageToVideoModel) => void;
  disabled?: boolean;
  /** Per-scene generation status by model (#545); renders ✓/⟳/! in the list. */
  generatedStatuses?: Map<string, ModelGenerationStatus>;
} & MotionModelFilterProps;

export const MotionModelSelector: React.FC<MotionModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  aspectRatio,
  styleCategory,
  recommendedVideoModel,
  styleName,
  referenceOnly,
  generatedStatuses,
  allowedIds,
}) => {
  const baseModels = useMotionModels({
    aspectRatio,
    styleCategory,
    recommendedVideoModel,
    styleName,
    allowedIds,
    referenceOnly,
    keepId: selectedModel,
  });
  const models = useMemo(
    () =>
      baseModels.map((m) => ({
        ...m,
        generationStatus: generatedStatuses?.get(m.id),
      })),
    [baseModels, generatedStatuses]
  );
  const recommendationStatus = useRecommendationStatus(
    recommendedVideoModel,
    aspectRatio,
    allowedIds
  );

  return (
    <div className="flex flex-col gap-1">
      <BaseModelSelector
        label="Motion Model"
        models={models}
        groupOrder={SELECTOR_GROUP_ORDER}
        selectedIds={[selectedModel]}
        onSelectionChange={(ids) => {
          const firstId = ids[0];
          if (firstId && isValidImageToVideoModel(firstId)) {
            onModelChange(firstId);
          }
        }}
        disabled={disabled}
        multiSelect={false}
      />
      <RecommendationHint
        status={recommendationStatus}
        recommendedVideoModel={recommendedVideoModel}
        styleName={styleName}
      />
    </div>
  );
};

type MotionModelMultiSelectorProps = {
  selectedModels: ImageToVideoModel[];
  onModelsChange: (models: ImageToVideoModel[]) => void;
  disabled?: boolean;
} & MotionModelFilterProps;

export const MotionModelMultiSelector: React.FC<
  MotionModelMultiSelectorProps
> = ({
  selectedModels,
  onModelsChange,
  disabled = false,
  aspectRatio,
  styleCategory,
  recommendedVideoModel,
  styleName,
  allowedIds,
  referenceOnly,
}) => {
  const models = useMotionModels({
    aspectRatio,
    styleCategory,
    recommendedVideoModel,
    styleName,
    allowedIds,
    referenceOnly,
  });
  const recommendationStatus = useRecommendationStatus(
    recommendedVideoModel,
    aspectRatio,
    allowedIds
  );

  return (
    <div className="flex flex-col gap-1">
      <BaseModelSelector
        label="Motion Models"
        models={models}
        groupOrder={SELECTOR_GROUP_ORDER}
        selectedIds={selectedModels}
        onSelectionChange={(ids) => {
          const validIds = ids.filter(isValidImageToVideoModel);
          if (validIds.length > 0) {
            onModelsChange(validIds);
          }
        }}
        disabled={disabled}
        multiSelect={true}
      />
      <RecommendationHint
        status={recommendationStatus}
        recommendedVideoModel={recommendedVideoModel}
        styleName={styleName}
      />
    </div>
  );
};
