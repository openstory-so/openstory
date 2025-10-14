import Image from "next/image";
import type * as React from "react";
import { useCallback } from "react";
import { GalleryIcon } from "@/components/icons/gallery-icon";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Style } from "@/types/database";

interface StyleSelectorProps {
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  styles: Style[];
  disabled?: boolean;
  loading?: boolean;
}

interface StyleCardProps {
  style: Style;
  selected: boolean;
  onSelect: (styleId: string) => void;
  disabled?: boolean;
}

const StyleCard: React.FC<StyleCardProps> = ({
  style,
  selected,
  onSelect,
  disabled = false,
}) => {
  const handleClick = useCallback(() => {
    if (!disabled) {
      onSelect(style.id);
    }
  }, [style.id, onSelect, disabled]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  return (
    <Card
      className={cn(
        "cursor-pointer transition-all duration-200 hover:shadow-md",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        selected && "ring-2 ring-primary ring-offset-2",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={disabled}
      data-testid={`style-card-${style.id}`}
    >
      <CardContent className="p-4">
        <div className="flex flex-col gap-3">
          <div className="aspect-[4/3] overflow-hidden rounded-lg bg-muted">
            {style.preview_url ? (
              <Image
                src={style.preview_url}
                alt={`${style.name} style preview`}
                className="h-full w-full object-cover"
                loading="lazy"
                width={400}
                height={300}
                onError={(e) => {
                  console.warn(
                    `Failed to load image for style ${style.name}:`,
                    style.preview_url,
                  );
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center bg-muted">
                <GalleryIcon
                  className="text-muted-foreground opacity-50"
                  size="lg"
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-sm line-clamp-1" title={style.name}>
              {style.name}
            </h3>

            {style.config &&
              typeof style.config === "object" &&
              "artStyle" in style.config && (
                <p className="text-xs text-muted-foreground line-clamp-1">
                  {String(style.config.artStyle)}
                </p>
              )}

            {style.config &&
              typeof style.config === "object" &&
              "colorPalette" in style.config &&
              Array.isArray(style.config.colorPalette) && (
                <div className="flex gap-1 mt-1" data-testid="color-palette">
                  {style.config.colorPalette.slice(0, 4).map((color, index) => (
                    <div
                      key={`color-${String(color)}-${index}`}
                      className="w-3 h-3 rounded-full border border-border/20"
                      style={{ backgroundColor: String(color) }}
                      title={String(color)}
                    />
                  ))}
                  {style.config.colorPalette.length > 4 && (
                    <div className="flex items-center justify-center w-3 h-3 text-[8px] text-muted-foreground">
                      +{style.config.colorPalette.length - 4}
                    </div>
                  )}
                </div>
              )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const StyleCardSkeleton: React.FC = () => (
  <Card>
    <CardContent className="p-4">
      <div className="flex flex-col gap-3">
        <Skeleton className="aspect-[4/3] w-full rounded-lg" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <div className="flex gap-1 mt-1">
            <Skeleton className="w-3 h-3 rounded-full" />
            <Skeleton className="w-3 h-3 rounded-full" />
            <Skeleton className="w-3 h-3 rounded-full" />
            <Skeleton className="w-3 h-3 rounded-full" />
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
);

export const StyleSelector: React.FC<StyleSelectorProps> = ({
  selectedStyleId,
  onStyleSelect,
  styles,
  disabled = false,
  loading = false,
}) => {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton key
          <StyleCardSkeleton key={`skeleton-${index}`} />
        ))}
      </div>
    );
  }

  if (styles.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="empty-state"
      >
        <div className="rounded-full bg-muted p-6 mb-4">
          <GalleryIcon className="text-muted-foreground" size="lg" />
        </div>
        <h3 className="text-lg font-medium mb-2">No styles available</h3>
        <p className="text-muted-foreground max-w-sm">
          There are currently no styles to choose from. Check back later or
          contact your team administrator.
        </p>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
      data-testid="styles-grid"
    >
      {styles.map((style) => (
        <StyleCard
          key={style.id}
          style={style}
          selected={selectedStyleId === style.id}
          onSelect={onStyleSelect}
          disabled={disabled}
        />
      ))}
    </div>
  );
};
