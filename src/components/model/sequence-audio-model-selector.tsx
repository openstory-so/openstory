import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useActiveAudioModel } from '@/hooks/use-active-audio-model';
import { useSequenceAudioModels } from '@/hooks/use-sequences';
import { AUDIO_MODELS, isValidAudioModel } from '@/lib/ai/models';
import { ChevronDown } from 'lucide-react';

function audioModelName(model: string): string {
  return isValidAudioModel(model) ? AUDIO_MODELS[model].name : model;
}

/**
 * Top-level audio-model switcher for the sequence header (#546). Replaces the
 * old read-only music chip once any music variants exist: lists the distinct
 * models that have generated a track for this sequence (derived from
 * sequence_music_variants) and lets the viewer pick which model's track plays.
 * Viewer-local (localStorage via useActiveAudioModel). "Mixed" is shown when
 * more than one model has output and no specific one is pinned.
 */
export const SequenceAudioModelSelector = ({
  sequenceId,
  sequenceMusicModel,
}: {
  sequenceId: string;
  sequenceMusicModel?: string | null;
}) => {
  const { data: models } = useSequenceAudioModels(sequenceId);
  const { activeAudioModel, selectAudioModel } =
    useActiveAudioModel(sequenceId);

  if (!models || models.length === 0) {
    if (!sequenceMusicModel) return null;
    return (
      <Badge variant="secondary" className="text-xs">
        {audioModelName(sequenceMusicModel)}
      </Badge>
    );
  }

  const firstModel = models[0];
  const label = activeAudioModel
    ? audioModelName(activeAudioModel)
    : models.length === 1 && firstModel
      ? audioModelName(firstModel)
      : 'Mixed';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select audio model">
          <Badge variant="secondary" className="text-xs cursor-pointer gap-1">
            {label}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuLabel className="text-xs">Audio model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length > 1 && (
          <DropdownMenuCheckboxItem
            checked={activeAudioModel === null}
            onCheckedChange={() => selectAudioModel(null)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            Mixed (primary)
          </DropdownMenuCheckboxItem>
        )}
        {models.filter(isValidAudioModel).map((model) => (
          <DropdownMenuCheckboxItem
            key={model}
            checked={activeAudioModel === model}
            onCheckedChange={() => selectAudioModel(model)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            {audioModelName(model)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
