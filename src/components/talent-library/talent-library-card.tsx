import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToggleTalentFavorite } from '@/hooks/use-talent';
import type { TalentWithSheets } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { ImageIcon, Loader2, Sparkles, Star, User } from 'lucide-react';
import type React from 'react';
import { AppImage } from '@/components/ui/app-image';

type TalentLibraryCardProps = {
  talent: TalentWithSheets;
  isGenerating?: boolean;
  generatingLabel?: string;
  divergentVariantId?: string;
};

export const TalentLibraryCard: React.FC<TalentLibraryCardProps> = ({
  talent,
  isGenerating = false,
  generatingLabel = 'Generating sheet…',
  divergentVariantId,
}) => {
  const toggleFavorite = useToggleTalentFavorite();
  // Prefer talent headshot (square), fall back to default sheet
  const previewUrl = talent.imageUrl ?? talent.defaultSheet?.imageUrl;

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite.mutate(talent.id);
  };

  return (
    <Card className="group relative overflow-hidden hover:shadow-lg transition-shadow">
      {/* Real anchor navigation: works before hydration and supports
          Cmd/Ctrl/middle-click. Interactive overlays (favorite, staleness)
          live as siblings outside the anchor. */}
      <Link
        to="/talent/$id"
        params={{ id: talent.id }}
        aria-label={talent.name}
        className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Preview image */}
        <div className="aspect-square bg-muted relative">
          {previewUrl ? (
            <AppImage
              src={previewUrl}
              alt={talent.name}
              width={160}
              height={160}
              className={cn(
                'w-full h-full object-cover',
                isGenerating && 'opacity-50'
              )}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <User className="h-16 w-16 text-muted-foreground/30" />
            </div>
          )}

          {/* Generating overlay */}
          {isGenerating && (
            <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="text-xs font-medium">{generatingLabel}</span>
              </div>
            </div>
          )}

          {/* Badge */}
          {talent.isPublic ? (
            <div className="absolute top-2 left-2 px-2 py-1 bg-background/80 backdrop-blur-sm rounded text-xs font-medium text-muted-foreground">
              System
            </div>
          ) : talent.isHuman ? (
            <div className="absolute top-2 left-2 px-2 py-1 bg-background/80 backdrop-blur-sm rounded text-xs font-medium">
              Human
            </div>
          ) : (
            <div className="absolute top-2 left-2 px-2 py-1 bg-background/80 backdrop-blur-sm rounded text-xs font-medium flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              AI
            </div>
          )}
        </div>

        {/* Info section */}
        <div className="p-4">
          <h3 className="font-semibold text-base line-clamp-1 mb-1">
            {talent.name}
          </h3>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <ImageIcon className="h-3 w-3" />
              <span>
                {talent.sheetCount}{' '}
                {talent.sheetCount === 1 ? 'sheet' : 'sheets'}
              </span>
            </div>
          </div>

          {talent.description && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
              {talent.description}
            </p>
          )}
        </div>
      </Link>

      {/* Favorite button overlay (sibling of the anchor so its click never
          triggers navigation) */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'absolute top-2 right-2 z-10 h-8 w-8 bg-background/80 backdrop-blur-sm',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          talent.isFavorite && 'opacity-100'
        )}
        onClick={handleFavoriteClick}
        disabled={toggleFavorite.isPending}
      >
        <Star
          className={cn(
            'h-4 w-4',
            talent.isFavorite
              ? 'fill-yellow-400 text-yellow-400'
              : 'text-muted-foreground'
          )}
        />
      </Button>

      {divergentVariantId && (
        <div
          // The favourite star already occupies `right-2`; offset to its
          // left so both indicators are visible.
          className="absolute right-12 top-2 z-10"
          role="presentation"
        >
          <SheetStalenessBanners
            density="corner-dot"
            entityType="talent"
            divergentVariantId={divergentVariantId}
          />
        </div>
      )}
    </Card>
  );
};
