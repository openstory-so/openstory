import { Button } from '@/components/ui/button';
import type { Style } from '@/types/database';
import { AppImage } from '@/components/ui/app-image';
import { ChevronDown } from 'lucide-react';
import { useState, type FC } from 'react';
import { getStyleGradient } from './style-gradient';
import { getConfigColorPalette } from '@/lib/style/style-config';

type StyleSelectorButtonProps = {
  selectedStyle?: Style | null;
  onClick?: () => void;
  size?: 'default' | 'sm' | 'lg';
};

export const StyleSelectorButton: FC<StyleSelectorButtonProps> = ({
  selectedStyle,
  onClick,
  size = 'default',
}) => {
  const sizeClasses = {
    sm: 'h-12 px-3 text-sm',
    default: 'h-16 px-4 text-base',
    lg: 'h-20 px-5 text-lg',
  };

  const labelSizeClasses = {
    sm: 'text-xs',
    default: 'text-sm',
    lg: 'text-base',
  };

  const nameSizeClasses = {
    sm: 'text-base',
    default: 'text-2xl',
    lg: 'text-3xl',
  };

  const hoverScaleClasses = {
    sm: 'hover:scale-105',
    default: 'hover:scale-[1.03]',
    lg: 'hover:scale-[1.02]',
  };

  const [imgError, setImgError] = useState(false);
  const previewUrl = selectedStyle?.previewUrl;
  const showImage = previewUrl && !imgError;

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={onClick}
      className={`relative overflow-hidden ${sizeClasses[size]} min-w-[200px] justify-start rounded-2xl border-2 border-background bg-background/95 backdrop-blur-sm shadow-lg transition-all duration-200 ${hoverScaleClasses[size]} hover:border-foreground/60 hover:shadow-xl`}
    >
      {/* Background thumbnail / gradient with overlay */}
      {selectedStyle && (
        <>
          {showImage ? (
            <AppImage
              key={selectedStyle.id}
              src={previewUrl}
              layout="fullWidth"
              alt={selectedStyle.name}
              className="absolute inset-0 h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div
              className="absolute inset-0"
              style={{
                background: getStyleGradient(
                  getConfigColorPalette(selectedStyle.config)
                ),
              }}
            />
          )}
          {/* Subtle dark overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/40 to-black/20" />
        </>
      )}

      {/* Content */}
      <div className="relative z-10 flex w-full items-center justify-between gap-3">
        <div className="flex flex-col items-start">
          {/* Selected style name */}
          {selectedStyle ? (
            <>
              <span
                className={`font-bold uppercase tracking-wide text-foreground ${nameSizeClasses[size]}`}
              >
                {selectedStyle.name}
              </span>
              {selectedStyle.category && (
                <span
                  className={`text-muted-foreground ${labelSizeClasses[size]}`}
                >
                  {selectedStyle.category}
                </span>
              )}
            </>
          ) : (
            <span>Select Style</span>
          )}
        </div>

        {/* Chevron indicator */}
        <ChevronDown className="h-6 w-6 text-primary" />
      </div>
    </Button>
  );
};
