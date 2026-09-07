import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ASPECT_RATIOS,
  aspectRatioSchema,
  type AspectRatio,
} from '@/shared/constants/aspect-ratios';
import type { FC } from 'react';

function isValidAspectRatio(value: string): value is AspectRatio {
  return aspectRatioSchema.safeParse(value).success;
}

type AspectRatioPillsProps = {
  value: AspectRatio;
  onChange: (value: AspectRatio) => void;
};

export const AspectRatioPills: FC<AspectRatioPillsProps> = ({
  value,
  onChange,
}) => {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(val) => {
        if (val && isValidAspectRatio(val)) {
          onChange(val);
        }
      }}
      variant="outline"
      spacing={0}
      className="w-full min-w-0 flex-nowrap justify-start"
    >
      {ASPECT_RATIOS.map((ratio) => (
        <ToggleGroupItem
          key={ratio.value}
          value={ratio.value}
          className="flex h-9 min-w-0 flex-1 shrink items-center justify-center gap-2 px-2 sm:px-3"
          aria-label={`${ratio.label} aspect ratio`}
        >
          <AspectRatioIcon
            width={ratio.width}
            height={ratio.height}
            size="sm"
          />
          <span className="font-mono text-xs">{ratio.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};
