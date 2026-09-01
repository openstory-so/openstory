import {
  BaseModelSelector,
  type ModelGenerationStatus,
} from './base-model-selector';
import {
  AUDIO_MODELS,
  isValidAudioModel,
  type AudioModel,
} from '@/lib/ai/models';
import {
  compareSelectorModels,
  QUALITY_DEFAULT_AUDIO,
  SELECTOR_GROUP_ORDER,
  selectorGroup,
  TURBO_AUDIO_MODELS,
} from '@/lib/ai/generation-mode';
import { useMemo } from 'react';

// Shared option list — only music models (not SFX), sorted by quality.
function useMusicModels(allowedIds?: readonly AudioModel[]) {
  return useMemo(
    () =>
      Object.entries(AUDIO_MODELS)
        .filter(([key, m]) => {
          if (!isValidAudioModel(key)) return false;
          if (allowedIds && !allowedIds.includes(key)) return false;
          // Only show music models, not SFX. All current entries are 'music',
          // but keep the check so adding an SFX model can't accidentally appear here.
          // oxlint-disable-next-line typescript/no-unnecessary-condition
          return m.type === 'music';
        })
        .sort(([a], [b]) =>
          compareSelectorModels(
            a,
            b,
            TURBO_AUDIO_MODELS,
            QUALITY_DEFAULT_AUDIO,
            (id) => (isValidAudioModel(id) ? AUDIO_MODELS[id].qualityRank : 99)
          )
        )
        .map(([key, m]) => ({
          id: key,
          name: m.name,
          group: selectorGroup(key, TURBO_AUDIO_MODELS),
          badge: m.license,
        })),
    [allowedIds]
  );
}

type MusicModelSelectorProps = {
  selectedModel: AudioModel;
  onModelChange: (model: AudioModel) => void;
  disabled?: boolean;
  /** Per-model generation status (#546); renders ⊙/✓/⟳/! in the list. */
  generatedStatuses?: Map<string, ModelGenerationStatus>;
  allowedIds?: readonly AudioModel[];
};

export const MusicModelSelector: React.FC<MusicModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  generatedStatuses,
  allowedIds,
}) => {
  const baseModels = useMusicModels(allowedIds);
  const models = useMemo(
    () =>
      baseModels.map((m) => ({
        ...m,
        generationStatus: generatedStatuses?.get(m.id),
      })),
    [baseModels, generatedStatuses]
  );

  return (
    <BaseModelSelector
      label="Music Model"
      models={models}
      groupOrder={SELECTOR_GROUP_ORDER}
      selectedIds={[selectedModel]}
      onSelectionChange={(ids) => {
        const firstId = ids[0];
        if (firstId && isValidAudioModel(firstId)) {
          onModelChange(firstId);
        }
      }}
      disabled={disabled}
      multiSelect={false}
    />
  );
};

type MusicModelMultiSelectorProps = {
  selectedModels: AudioModel[];
  onModelsChange: (models: AudioModel[]) => void;
  disabled?: boolean;
  allowedIds?: readonly AudioModel[];
};

export const MusicModelMultiSelector: React.FC<
  MusicModelMultiSelectorProps
> = ({ selectedModels, onModelsChange, disabled = false, allowedIds }) => {
  const models = useMusicModels(allowedIds);

  return (
    <BaseModelSelector
      label="Music Models"
      models={models}
      groupOrder={SELECTOR_GROUP_ORDER}
      selectedIds={selectedModels}
      onSelectionChange={(ids) => {
        const validIds = ids.filter(isValidAudioModel);
        if (validIds.length > 0) {
          onModelsChange(validIds);
        }
      }}
      disabled={disabled}
      multiSelect={true}
    />
  );
};
