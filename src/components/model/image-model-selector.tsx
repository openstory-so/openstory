import {
  BaseModelSelector,
  type ModelGenerationStatus,
} from './base-model-selector';
import {
  IMAGE_MODELS,
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  compareSelectorModels,
  QUALITY_DEFAULT_IMAGE,
  SELECTOR_GROUP_ORDER,
  selectorGroup,
  TURBO_IMAGE_MODELS,
} from '@/lib/ai/generation-mode';
import { useMemo } from 'react';

type RecommendationProps = {
  /** Style-recommended model key — renders a "Recommended" badge on the match. */
  recommendedImageModel?: string | null;
  /** Style name, used in the recommendation tooltip. */
  styleName?: string;
};

type RecommendationStatus =
  | { kind: 'matched'; modelName: string }
  | { kind: 'hidden-by-filter'; modelName: string }
  | { kind: 'unknown' }
  | { kind: 'none' };

function resolveRecommendation(
  recommendedImageModel: string | null | undefined,
  filterModels: TextToImageModel[] | undefined
): RecommendationStatus {
  if (!recommendedImageModel) return { kind: 'none' };
  if (!isValidTextToImageModel(recommendedImageModel))
    return { kind: 'unknown' };
  const modelName = IMAGE_MODELS[recommendedImageModel].name;
  if (filterModels && !filterModels.includes(recommendedImageModel)) {
    return { kind: 'hidden-by-filter', modelName };
  }
  return { kind: 'matched', modelName };
}

function useImageModels({
  recommendedImageModel,
  styleName,
}: RecommendationProps = {}) {
  return useMemo(
    () =>
      Object.entries(IMAGE_MODELS)
        .filter(([, m]) => !('hidden' in m))
        .sort(([a], [b]) =>
          compareSelectorModels(
            a,
            b,
            TURBO_IMAGE_MODELS,
            QUALITY_DEFAULT_IMAGE,
            (id) =>
              isValidTextToImageModel(id) ? IMAGE_MODELS[id].qualityRank : 99
          )
        )
        .map(([key, m]) => ({
          id: key,
          name: m.name,
          group: selectorGroup(key, TURBO_IMAGE_MODELS),
          badge: m.license,
          recommendedFor:
            recommendedImageModel && key === recommendedImageModel
              ? styleName
                ? `Recommended for ${styleName}`
                : 'Recommended for this style'
              : undefined,
        })),
    [recommendedImageModel, styleName]
  );
}

function RecommendationHint({
  status,
  styleName,
}: {
  status: RecommendationStatus;
  styleName: string | undefined;
}) {
  if (status.kind === 'matched' || status.kind === 'none') return null;
  const prefix = styleName ? `${styleName} recommends` : 'Recommended';
  if (status.kind === 'unknown') {
    return (
      <p className="text-[10px] text-muted-foreground">
        {prefix} a model that's no longer available.
      </p>
    );
  }
  return (
    <p className="text-[10px] text-muted-foreground">
      {prefix} <span className="font-medium">{status.modelName}</span>, but it's
      not available in this selector.
    </p>
  );
}

type ImageModelSelectorProps = {
  selectedModel: TextToImageModel;
  onModelChange: (model: TextToImageModel) => void;
  disabled?: boolean;
  /** When set, only show these models instead of all available models */
  filterModels?: TextToImageModel[];
  /** Per-scene generation status by model (#545); renders ✓/⟳/! in the list. */
  generatedStatuses?: Map<string, ModelGenerationStatus>;
} & RecommendationProps;

export const ImageModelSelector: React.FC<ImageModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  filterModels,
  recommendedImageModel,
  styleName,
  generatedStatuses,
}) => {
  const allModels = useImageModels({ recommendedImageModel, styleName });
  const models = useMemo(() => {
    const filtered = filterModels
      ? allModels.filter(
          (m) => isValidTextToImageModel(m.id) && filterModels.includes(m.id)
        )
      : allModels;
    return filtered.map((m) => ({
      ...m,
      generationStatus: generatedStatuses?.get(m.id),
    }));
  }, [allModels, filterModels, generatedStatuses]);
  const status = useMemo(
    () => resolveRecommendation(recommendedImageModel, filterModels),
    [recommendedImageModel, filterModels]
  );

  return (
    <div className="flex flex-col gap-1">
      <BaseModelSelector
        label="Image Model"
        models={models}
        groupOrder={SELECTOR_GROUP_ORDER}
        selectedIds={[selectedModel]}
        onSelectionChange={(ids) => {
          const firstId = ids[0];
          if (firstId && isValidTextToImageModel(firstId)) {
            onModelChange(firstId);
          }
        }}
        disabled={disabled}
        multiSelect={false}
      />
      <RecommendationHint status={status} styleName={styleName} />
    </div>
  );
};

type ImageModelMultiSelectorProps = {
  selectedModels: TextToImageModel[];
  onModelsChange: (models: TextToImageModel[]) => void;
  disabled?: boolean;
  filterModels?: TextToImageModel[];
} & RecommendationProps;

export const ImageModelMultiSelector: React.FC<
  ImageModelMultiSelectorProps
> = ({
  selectedModels,
  onModelsChange,
  disabled = false,
  recommendedImageModel,
  styleName,
  filterModels,
}) => {
  const allModels = useImageModels({ recommendedImageModel, styleName });
  const models = useMemo(
    () =>
      filterModels
        ? allModels.filter(
            (m) => isValidTextToImageModel(m.id) && filterModels.includes(m.id)
          )
        : allModels,
    [allModels, filterModels]
  );
  const status = useMemo(
    () => resolveRecommendation(recommendedImageModel, filterModels),
    [recommendedImageModel, filterModels]
  );

  return (
    <div className="flex flex-col gap-1">
      <BaseModelSelector
        label="Image Models"
        models={models}
        groupOrder={SELECTOR_GROUP_ORDER}
        selectedIds={selectedModels}
        onSelectionChange={(ids) => {
          const validIds = ids.filter(isValidTextToImageModel);
          if (validIds.length > 0) {
            onModelsChange(validIds);
          }
        }}
        disabled={disabled}
        multiSelect={true}
      />
      <RecommendationHint status={status} styleName={styleName} />
    </div>
  );
};
