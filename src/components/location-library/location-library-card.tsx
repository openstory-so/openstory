import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Card } from '@/components/ui/card';
import type { LibraryLocation } from '@/lib/db/schema';
import { cn } from '@/shared/utils';
import { Link } from '@tanstack/react-router';
import { Loader2, MapPin } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';

type LocationLibraryCardProps = {
  location: LibraryLocation;
  isGenerating?: boolean;
  divergentVariantId?: string;
};

export const LocationLibraryCard: React.FC<LocationLibraryCardProps> = ({
  location,
  isGenerating = false,
  divergentVariantId,
}) => {
  const previewUrl = location.referenceImageUrl;

  return (
    <Card className="group relative overflow-hidden hover:shadow-lg transition-shadow">
      {/* Real anchor navigation: works before hydration and supports
          Cmd/Ctrl/middle-click. Interactive overlays live as siblings
          outside the anchor. */}
      <Link
        to="/locations/$locationId"
        params={{ locationId: location.id }}
        aria-label={location.name}
        className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Preview image - 16:9 aspect ratio for locations */}
        <div className="aspect-video bg-muted relative">
          {previewUrl ? (
            <AppImage
              src={previewUrl}
              alt={location.name}
              width={160}
              height={160}
              className={cn(
                'w-full h-full object-cover',
                isGenerating && 'opacity-50'
              )}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <MapPin className="h-12 w-12 text-muted-foreground/30" />
            </div>
          )}

          {/* Generating overlay */}
          {isGenerating && (
            <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="text-xs font-medium">Generating sheet…</span>
              </div>
            </div>
          )}

          {/* System badge */}
          {location.isPublic && (
            <div className="absolute top-2 left-2 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              System
            </div>
          )}
        </div>

        {/* Info section */}
        <div className="p-4">
          <h3 className="font-semibold text-sm line-clamp-1 mb-1">
            {location.name}
          </h3>

          {location.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {location.description}
            </p>
          )}
        </div>
      </Link>

      {divergentVariantId && (
        <div className="absolute right-2 top-2 z-10" role="presentation">
          <SheetStalenessBanners
            density="corner-dot"
            entityType="library-location"
            divergentVariantId={divergentVariantId}
          />
        </div>
      )}
    </Card>
  );
};
