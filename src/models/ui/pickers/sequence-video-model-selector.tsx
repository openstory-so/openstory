import { Badge } from '@/ui/shadcn/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { AddModelMenuSection } from './add-model-menu';
import { ModelCoverageMarker } from './model-coverage-marker';
import { SetModelButton } from './set-model-button';
import {
  useSequenceVideoModels,
  useSequenceVideoVariants,
  useShotsBySequence,
} from '@/shots/ui/use-shots';
import {
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
} from '@/models/models';
import { computeSequenceModelCoverage } from './sequence-model-coverage';
import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

function videoModelName(model: string): string {
  return isValidImageToVideoModel(model)
    ? IMAGE_TO_VIDEO_MODELS[model].name
    : model;
}

/**
 * Sequence-wide video models (#545). Lists the distinct models that have
 * generated a video for this sequence, with each one's coverage and the
 * sequence-wide Set; also hosts "Add a model". It does not change what plays:
 * each shot plays its current version, which history repoints.
 *
 * "Mixed" is shown when more than one model has output.
 *
 * Lives in the Scenes inspector at sequence scope as the ONLY video-model
 * control there, styled as a badge to match the rows beside it. Degrades to a
 * read-only badge before any video exists, and renders nothing at all when the
 * sequence has no video model (motion off). See the image selector's note.
 */
export const SequenceVideoModelSelector = ({
  sequenceId,
  sequenceVideoModel,
  label,
}: {
  sequenceId: string;
  sequenceVideoModel?: string | null;
  label?: string;
}) => {
  const { data: models } = useSequenceVideoModels(sequenceId);
  const { data: variants } = useSequenceVideoVariants(sequenceId);
  const { data: shots } = useShotsBySequence(sequenceId);

  // Map shots → their parent scene so coverage counts at scene granularity (#909).
  const shotToScene = useMemo(() => {
    const map = new Map<string, string>();
    for (const shot of shots ?? []) map.set(shot.id, shot.sceneId ?? shot.id);
    return map;
  }, [shots]);

  const coverage = useMemo(
    () =>
      computeSequenceModelCoverage({
        variants,
        variantType: 'video',
        primaryModel: sequenceVideoModel,
        shotToScene,
      }),
    [variants, sequenceVideoModel, shotToScene]
  );

  const withLabel = (content: React.ReactNode) =>
    label ? (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {content}
      </div>
    ) : (
      content
    );

  // No video variants generated yet — fall back to the read-only chip showing
  // the sequence's configured model (or render nothing when motion is off).
  if (!models || models.length === 0) {
    if (!sequenceVideoModel) return null;
    return withLabel(
      <Badge variant="secondary" className="text-xs">
        {videoModelName(sequenceVideoModel)}
      </Badge>
    );
  }

  const firstModel = models[0];
  const activeLabel =
    models.length === 1 && firstModel ? videoModelName(firstModel) : 'Mixed';

  const dropdown = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select video model">
          <Badge variant="secondary" className="text-xs cursor-pointer gap-1">
            {activeLabel}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={12}
        className="w-[min(280px,calc(100vw-2rem))]"
      >
        <DropdownMenuLabel className="text-xs">
          Video model
          <span className="block font-normal text-muted-foreground">
            Set applies a model to every scene.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.filter(isValidImageToVideoModel).map((model) => (
          <DropdownMenuItem key={model} onSelect={(e) => e.preventDefault()}>
            <span className="flex w-full items-center justify-between gap-2">
              <span className="truncate">{videoModelName(model)}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <ModelCoverageMarker coverage={coverage.get(model)} />
                <SetModelButton
                  sequenceId={sequenceId}
                  variantType="video"
                  model={model}
                  modelName={videoModelName(model)}
                  coverage={coverage.get(model)}
                />
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <AddModelMenuSection
          sequenceId={sequenceId}
          variantType="video"
          usedModels={models}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return withLabel(dropdown);
};
