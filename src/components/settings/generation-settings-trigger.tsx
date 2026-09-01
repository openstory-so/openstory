import { Button } from '@/components/ui/button';
import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/constants/aspect-ratios';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { FC, ComponentProps } from 'react';

type GenerationSettingsTriggerProps = {
  aspectRatio: AspectRatio;
} & ComponentProps<typeof Button>;

export const GenerationSettingsTrigger: FC<GenerationSettingsTriggerProps> = ({
  aspectRatio,
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
      <SlidersHorizontal className="size-3.5 text-muted-foreground" />
      <ChevronDown className="size-3.5 text-muted-foreground" />
    </Button>
  );
};
