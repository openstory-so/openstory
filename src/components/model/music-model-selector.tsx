import { BaseModelSelector } from './base-model-selector';
import {
  AUDIO_MODELS,
  isValidAudioModel,
  type AudioModel,
} from '@/lib/ai/models';
import { useMemo } from 'react';

const GROUP_ORDER = ['all'] as const;

// Shared option list — only music models (not SFX), sorted by quality.
function useMusicModels() {
  return useMemo(
    () =>
      Object.entries(AUDIO_MODELS)
        .filter(([key, m]) => {
          if (!isValidAudioModel(key)) return false;
          // Only show music models, not SFX. All current entries are 'music',
          // but keep the check so adding an SFX model can't accidentally appear here.
          // oxlint-disable-next-line typescript/no-unnecessary-condition
          return m.type === 'music';
        })
        .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
        .map(([key, m]) => ({
          id: key,
          name: m.name,
          group: 'all',
          badge: m.license,
        })),
    []
  );
}

type MusicModelSelectorProps = {
  selectedModel: AudioModel;
  onModelChange: (model: AudioModel) => void;
  disabled?: boolean;
};

export const MusicModelSelector: React.FC<MusicModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
}) => {
  const models = useMusicModels();

  return (
    <BaseModelSelector
      label="Music Model"
      models={models}
      groupOrder={GROUP_ORDER}
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
};

export const MusicModelMultiSelector: React.FC<
  MusicModelMultiSelectorProps
> = ({ selectedModels, onModelsChange, disabled = false }) => {
  const models = useMusicModels();

  return (
    <BaseModelSelector
      label="Music Models"
      models={models}
      groupOrder={GROUP_ORDER}
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
