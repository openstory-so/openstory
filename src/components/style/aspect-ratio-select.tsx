import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ASPECT_RATIOS,
  aspectRatioSchema,
  type AspectRatio,
} from '@/shared/constants/aspect-ratios';
import { cn } from '@/shared/utils';
import { ChevronDown } from 'lucide-react';

function isValidAspectRatio(value: string): value is AspectRatio {
  return aspectRatioSchema.safeParse(value).success;
}

type AspectRatioSelectProps = {
  value?: AspectRatio;
  onChange?: (value: AspectRatio) => void;
  disabled?: boolean;
  placeholder?: string;
  size?: 'sm' | 'default' | 'lg';
  variant?: 'horizontal' | 'vertical';
  className?: string;
};

export const AspectRatioSelect = ({
  value,
  onChange,
  disabled = false,
  placeholder = 'Aspect ratio',
  size = 'default',
  variant = 'horizontal',
  className,
}: AspectRatioSelectProps) => {
  const selectedRatio = ASPECT_RATIOS.find((r) => r.value === value);

  if (variant === 'vertical') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={size}
            disabled={disabled}
            className={cn('flex-col h-auto gap-2', className)}
            aria-label="Select aspect ratio"
          >
            {selectedRatio ? (
              <>
                <AspectRatioIcon
                  width={selectedRatio.width}
                  height={selectedRatio.height}
                  size={size}
                />
                <span className="font-semibold">{selectedRatio.label}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(val) => {
              if (val && isValidAspectRatio(val)) {
                onChange?.(val);
              }
            }}
          >
            {ASPECT_RATIOS.map((ratio) => (
              <DropdownMenuRadioItem key={ratio.value} value={ratio.value}>
                <AspectRatioIcon
                  width={ratio.width}
                  height={ratio.height}
                  size={size}
                />
                <span>{ratio.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          disabled={disabled}
          className={className}
          aria-label="Select aspect ratio"
        >
          {selectedRatio ? (
            <>
              <AspectRatioIcon
                width={selectedRatio.width}
                height={selectedRatio.height}
                size="sm"
              />
              <span className="font-mono">{selectedRatio.value}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(val) => {
            if (val && isValidAspectRatio(val)) {
              onChange?.(val);
            }
          }}
        >
          {ASPECT_RATIOS.map((ratio) => (
            <DropdownMenuRadioItem key={ratio.value} value={ratio.value}>
              <AspectRatioIcon
                width={ratio.width}
                height={ratio.height}
                size="sm"
              />
              <span className="font-mono">{ratio.value}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
