import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { IMAGE_MODELS, isValidTextToImageModel } from '@/lib/ai/models';
import { getAnalysisModelById } from '@/lib/ai/models.config';

export const ModelBadge = ({ model }: { model?: string }) => {
  if (!model) {
    return <Skeleton className="w-[100px] h-[20px]" />;
  }

  return (
    <Badge
      variant={
        (getAnalysisModelById(model)?.qualityRank ?? 99) <= 4
          ? 'default'
          : 'secondary'
      }
      className="text-xs"
    >
      {getAnalysisModelById(model)?.name || model}
    </Badge>
  );
};

function getImageModelDisplayName(model: string): string {
  return isValidTextToImageModel(model) ? IMAGE_MODELS[model].name : model;
}

function formatImageModels(models: string[]): string {
  const [first, second] = models;
  if (!first) return '';
  if (models.length === 1) return getImageModelDisplayName(first);
  if (models.length === 2 && second)
    return `${getImageModelDisplayName(first)}, ${getImageModelDisplayName(second)}`;
  return `${getImageModelDisplayName(first)} + ${models.length - 1} others`;
}

function resolveModelList(
  models: string[] | undefined,
  model: string | undefined
): string[] {
  if (models && models.length > 0) return models;
  if (model) return [model];
  return [];
}

export const ImageModelBadge = ({
  model,
  models,
}: {
  model?: string;
  models?: string[];
}) => {
  const allModels = resolveModelList(models, model);

  if (allModels.length === 0) {
    return <Skeleton className="w-[100px] h-[20px]" />;
  }

  return (
    <Badge variant="secondary" className="text-xs">
      {formatImageModels(allModels)}
    </Badge>
  );
};
