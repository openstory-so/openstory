import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { getAnalysisModelById } from '@/shared/ai/models.config';

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
