import { BaseModelSelector } from './base-model-selector';
import { getRequestCountryFn } from '@/functions/ai';
import {
  isSelectableAnalysisModelId,
  isValidAnalysisModelId,
  SCRIPT_ANALYSIS_MODELS,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  compareSelectorModels,
  QUALITY_DEFAULT_ANALYSIS,
  SELECTOR_GROUP_ORDER,
  selectorGroup,
  TURBO_ANALYSIS_MODELS,
} from '@/lib/ai/generation-mode';
import {
  isRegionBlockedModel,
  resolveModelForCountry,
} from '@/lib/ai/region-policy';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

type ModelSelectorProps = {
  selectedModels: AnalysisModelId[];
  onModelsChange: (models: AnalysisModelId[]) => void;
  disabled?: boolean;
  singleSelect?: boolean;
  /** When set, only these ids appear. */
  allowedIds?: readonly AnalysisModelId[];
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModels,
  onModelsChange,
  disabled = false,
  singleSelect = false,
  allowedIds,
}) => {
  // Region-blocked vendors are hidden from the picker (#1259): a user in an
  // Anthropic-blocked country shouldn't be offered a model the server would
  // swap away anyway. While the country is loading, the unfiltered list shows
  // — the server-side swap in createSequences stays the enforcement.
  const { data: country } = useQuery({
    queryKey: ['request-country'],
    queryFn: () => getRequestCountryFn(),
    staleTime: Infinity,
  });

  const models = useMemo(
    () =>
      [...SCRIPT_ANALYSIS_MODELS]
        .filter((m) => isSelectableAnalysisModelId(m.id))
        .filter((m) => !isRegionBlockedModel(m.id, country))
        .filter((m) => !allowedIds || allowedIds.includes(m.id))
        .sort((a, b) =>
          compareSelectorModels(
            a.id,
            b.id,
            TURBO_ANALYSIS_MODELS,
            QUALITY_DEFAULT_ANALYSIS,
            (id) =>
              SCRIPT_ANALYSIS_MODELS.find((model) => model.id === id)
                ?.qualityRank ?? 99
          )
        )
        .map((m) => ({
          id: m.id,
          name: m.name,
          group: selectorGroup(m.id, TURBO_ANALYSIS_MODELS),
          badge: m.license,
        })),
    [country, allowedIds]
  );

  // Remap an already-selected blocked model (stored default, restored draft)
  // onto the region fallback so the selection matches what the list shows and
  // what the server will actually run.
  useEffect(() => {
    if (!country) return;
    const remapped = [
      ...new Set(selectedModels.map((m) => resolveModelForCountry(m, country))),
    ];
    const changed =
      remapped.length !== selectedModels.length ||
      remapped.some((m, i) => m !== selectedModels[i]);
    if (changed) onModelsChange(remapped);
  }, [country, selectedModels, onModelsChange]);

  return (
    <BaseModelSelector
      label="Analysis Model"
      models={models}
      groupOrder={SELECTOR_GROUP_ORDER}
      selectedIds={selectedModels}
      onSelectionChange={(ids) => {
        const validIds = ids.filter((id): id is AnalysisModelId =>
          isValidAnalysisModelId(id)
        );
        if (validIds.length > 0) {
          onModelsChange(validIds);
        }
      }}
      disabled={disabled}
      multiSelect={!singleSelect}
    />
  );
};
