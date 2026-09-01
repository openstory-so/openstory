import { AddModelMenuSection } from '@/components/model/add-model-menu';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModelCoverageMarker } from '@/components/model/model-coverage-marker';
import { SetModelButton } from '@/components/model/set-model-button';
import { useActiveImageModel } from '@/hooks/use-active-image-model';
import {
  useSequenceImageModels,
  useSequenceImageVariants,
  useShotsBySequence,
} from '@/hooks/use-shots';
import { IMAGE_MODELS, isValidTextToImageModel } from '@/lib/ai/models';
import { computeSequenceModelCoverage } from '@/lib/model/sequence-model-coverage';
import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

function imageModelName(model: string): string {
  return isValidTextToImageModel(model) ? IMAGE_MODELS[model].name : model;
}

/**
 * Sequence-wide image-model switcher. Lists the distinct image models that have
 * generated for this sequence (shot_variants) and lets the viewer pick which
 * model's image the scenes view shows; also hosts the "Add a model" picker
 * (#547) and the sequence-wide Set.
 *
 * Lives in the Scenes inspector at sequence scope as the ONLY image-model
 * control there, styled as a badge to match the Style / Script rows beside it.
 * Before anything has generated it degrades to a read-only badge naming the
 * model the first render will use — that seed is chosen on the Script tab,
 * alongside the other pre-generation settings.
 *
 * `label` is rendered inside so the whole row disappears when there is nothing
 * to show (no variants and no configured model).
 */
export const SequenceImageModelSelector = ({
  sequenceId,
  sequenceImageModel,
  label,
}: {
  sequenceId: string;
  sequenceImageModel?: string | null;
  label?: string;
}) => {
  const { data: models } = useSequenceImageModels(sequenceId);
  const { data: variants } = useSequenceImageVariants(sequenceId);
  const { data: shots } = useShotsBySequence(sequenceId);
  const { activeImageModel, selectImageModel } =
    useActiveImageModel(sequenceId);

  // Map shots → their parent scene so coverage counts at scene granularity (#909).
  const shotToScene = useMemo(() => {
    const map = new Map<string, string>();
    for (const shot of shots ?? []) map.set(shot.id, shot.sceneId ?? shot.id);
    return map;
  }, [shots]);

  // Image variants are frame_variants (#989); each row already carries its
  // owning `shotId` (frame ids ≠ shot ids), so coverage counts at scene
  // granularity directly.
  const coverage = useMemo(
    () =>
      computeSequenceModelCoverage({
        variants,
        variantType: 'image',
        primaryModel: sequenceImageModel,
        shotToScene,
      }),
    [variants, sequenceImageModel, shotToScene]
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

  if (!models || models.length === 0) {
    if (!sequenceImageModel) return null;
    return withLabel(
      <Badge variant="secondary" className="text-xs">
        {imageModelName(sequenceImageModel)}
      </Badge>
    );
  }

  const firstModel = models[0];
  const activeLabel = activeImageModel
    ? imageModelName(activeImageModel)
    : models.length === 1 && firstModel
      ? imageModelName(firstModel)
      : 'Mixed';

  const dropdown = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select image model">
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
          Image model
          <span className="block font-normal text-muted-foreground">
            View a model across the sequence; Set applies it to every scene.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length > 1 && (
          <DropdownMenuCheckboxItem
            checked={activeImageModel === null}
            onCheckedChange={() => selectImageModel(null)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            Mixed (per scene)
          </DropdownMenuCheckboxItem>
        )}
        {models.filter(isValidTextToImageModel).map((model) => (
          <DropdownMenuCheckboxItem
            key={model}
            checked={activeImageModel === model}
            onCheckedChange={() => selectImageModel(model)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="truncate">{imageModelName(model)}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <ModelCoverageMarker coverage={coverage.get(model)} />
                <SetModelButton
                  sequenceId={sequenceId}
                  variantType="image"
                  model={model}
                  modelName={imageModelName(model)}
                  coverage={coverage.get(model)}
                />
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <AddModelMenuSection
          sequenceId={sequenceId}
          variantType="image"
          usedModels={models}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return withLabel(dropdown);
};
