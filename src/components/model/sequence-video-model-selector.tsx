import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddModelMenuSection } from '@/components/model/add-model-menu';
import { ModelCoverageMarker } from '@/components/model/model-coverage-marker';
import { SetModelButton } from '@/components/model/set-model-button';
import { useActiveVideoModel } from '@/hooks/use-active-video-model';
import {
  useSequenceVideoModels,
  useSequenceVideoVariants,
  useShotsBySequence,
} from '@/hooks/use-shots';
import {
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
} from '@/lib/ai/models';
import { computeSequenceModelCoverage } from '@/lib/model/sequence-model-coverage';
import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

function videoModelName(model: string): string {
  return isValidImageToVideoModel(model)
    ? IMAGE_TO_VIDEO_MODELS[model].name
    : model;
}

/**
 * Sequence-wide video-model switcher (#545). Lists the distinct models that
 * have generated a video for this sequence (derived from shot_variants) and
 * lets the viewer pick which model's output to display; also hosts "Add a
 * model" and the sequence-wide Set. The view selection is viewer-local
 * (localStorage via useActiveVideoModel).
 *
 * "Mixed" is shown when more than one model has output and the viewer has not
 * pinned a specific one — i.e. each scene shows its own model's video.
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
  const { activeVideoModel, selectVideoModel } =
    useActiveVideoModel(sequenceId);

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
  const activeLabel = activeVideoModel
    ? videoModelName(activeVideoModel)
    : models.length === 1 && firstModel
      ? videoModelName(firstModel)
      : 'Mixed';

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
            View a model across the sequence; Set applies it to every scene.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length > 1 && (
          <DropdownMenuCheckboxItem
            checked={activeVideoModel === null}
            onCheckedChange={() => selectVideoModel(null)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            Mixed (per scene)
          </DropdownMenuCheckboxItem>
        )}
        {models.filter(isValidImageToVideoModel).map((model) => (
          <DropdownMenuCheckboxItem
            key={model}
            checked={activeVideoModel === model}
            onCheckedChange={() => selectVideoModel(model)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
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
          </DropdownMenuCheckboxItem>
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
