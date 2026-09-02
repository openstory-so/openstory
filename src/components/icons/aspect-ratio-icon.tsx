import { cn } from '@/shared/utils';

type AspectRatioIconProps = {
  width: number;
  height: number;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
};

const sizeConfig = {
  sm: { maxDimension: 20, containerClass: 'min-w-7 min-h-7' },
  default: { maxDimension: 32, containerClass: 'min-w-10 min-h-10' },
  lg: { maxDimension: 40, containerClass: 'min-w-12 min-h-12' },
};

export const AspectRatioIcon = ({
  width,
  height,
  size = 'default',
  className,
}: AspectRatioIconProps) => {
  const { maxDimension, containerClass } = sizeConfig[size];
  const aspectRatio = width / height;

  let iconWidth: number;
  let iconHeight: number;

  if (aspectRatio >= 1) {
    iconWidth = maxDimension;
    iconHeight = maxDimension / aspectRatio;
  } else {
    iconHeight = maxDimension;
    iconWidth = maxDimension * aspectRatio;
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center',
        containerClass,
        className
      )}
    >
      <div
        className="border-2 border-primary/40 bg-primary/20 rounded-sm"
        style={{
          width: `${iconWidth}px`,
          height: `${iconHeight}px`,
        }}
      />
    </div>
  );
};
