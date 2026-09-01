import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ASPECT_RATIOS,
  aspectRatioSchema,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { type FC } from 'react';

function isValidAspectRatio(value: string): value is AspectRatio {
  return aspectRatioSchema.safeParse(value).success;
}

type AspectRatioPillsProps = {
  value: AspectRatio;
  onChange: (value: AspectRatio) => void;
  /** Style-recommended aspect ratio — caption under the one-line pills. */
  recommendedAspectRatio?: string | null;
  /** Style name, used in the recommendation caption. */
  styleName?: string;
};

export const AspectRatioPills: FC<AspectRatioPillsProps> = ({
  value,
  onChange,
  recommendedAspectRatio,
  styleName,
}) => {
  const matchedRecommendation = ASPECT_RATIOS.find(
    (r) => r.value === recommendedAspectRatio
  );
  const unmatchedRecommendation =
    recommendedAspectRatio && !matchedRecommendation
      ? recommendedAspectRatio
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
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
        {ASPECT_RATIOS.map((ratio) => {
          const isRecommended = matchedRecommendation?.value === ratio.value;
          return (
            <ToggleGroupItem
              key={ratio.value}
              value={ratio.value}
              className="flex h-9 min-w-0 flex-1 shrink items-center justify-center gap-2 px-2 sm:px-3"
              aria-label={`${ratio.label} aspect ratio${
                isRecommended ? ' (recommended)' : ''
              }`}
            >
              <AspectRatioIcon
                width={ratio.width}
                height={ratio.height}
                size="sm"
              />
              <span className="font-mono text-xs">{ratio.label}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {matchedRecommendation ? (
        <p className="truncate text-[10px] text-muted-foreground">
          {styleName
            ? `${matchedRecommendation.label} recommended for ${styleName}`
            : `${matchedRecommendation.label} recommended`}
        </p>
      ) : null}
      {unmatchedRecommendation ? (
        <p className="truncate text-[10px] text-muted-foreground">
          {styleName ? `${styleName} recommends` : 'Recommended'}{' '}
          <span className="font-medium">{unmatchedRecommendation}</span>, which
          isn't available here.
        </p>
      ) : null}
    </div>
  );
};
