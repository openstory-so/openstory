import { Button } from '@/components/ui/button';
import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/constants/aspect-ratios';
import {
  GENERATION_STAGE_META,
  type GenerationStage,
} from '@/lib/generation/pipeline';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { FC, ComponentProps } from 'react';

type GenerationSettingsTriggerProps = {
  aspectRatio: AspectRatio;
  stopAt?: GenerationStage;
} & ComponentProps<typeof Button>;

export const GenerationSettingsTrigger: FC<GenerationSettingsTriggerProps> = ({
  aspectRatio,
  stopAt,
  ...props
}) => {
  const aspectRatioData = ASPECT_RATIOS.find((r) => r.value === aspectRatio);

  return (
    <Button
      variant="outline"
      className="gap-2"
      aria-label="Generation settings"
      {...props}
    >
      {aspectRatioData && (
        <AspectRatioIcon
          width={aspectRatioData.width}
          height={aspectRatioData.height}
          size="sm"
        />
      )}
      <span className="font-mono text-sm">{aspectRatio}</span>
      {stopAt && (
        <span className="hidden sm:inline text-xs text-muted-foreground">
          Until {GENERATION_STAGE_META[stopAt].shortName}
        </span>
      )}
      <SlidersHorizontal className="size-3.5 text-muted-foreground" />
      <ChevronDown className="size-3.5 text-muted-foreground" />
    </Button>
  );
};
