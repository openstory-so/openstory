import { BaseModelSelector } from './base-model-selector';
import { getRequestCountryFn } from '@/functions/ai';
import {
  isSelectableAnalysisModelId,
  isValidAnalysisModelId,
  SCRIPT_ANALYSIS_MODELS,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  isRegionBlockedModel,
  resolveModelForCountry,
} from '@/lib/ai/region-policy';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

const GROUP_ORDER = ['all'] as const;

type ModelSelectorProps = {
  selectedModels: AnalysisModelId[];
  onModelsChange: (models: AnalysisModelId[]) => void;
  disabled?: boolean;
  singleSelect?: boolean;
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModels,
  onModelsChange,
  disabled = false,
  singleSelect = false,
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
        .sort((a, b) => a.qualityRank - b.qualityRank)
        .map((m) => ({
          id: m.id,
          name: m.name,
          group: 'all',
          badge: m.license,
        })),
    [country]
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
      groupOrder={GROUP_ORDER}
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
