import type { TeamLocation } from '@/cast/server/db/locations';
import { locationUseLine } from '@/cast/ui/locations/location-picker-dialog';
import { SheetStalenessBanners } from '@/cast/ui/sheets/sheet-staleness-banners';
import { AppImage } from '@/ui/shadcn/app-image';
import { Card } from '@/ui/shadcn/card';
import { Link } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';
import type React from 'react';

/** One of the team's locations (#1695). The picture is its sheet. */
export const TeamLocationCard: React.FC<{
  location: TeamLocation;
  /** A sheet alternate waiting to be compared, shown as a corner dot. */
  divergentVariantId: string | undefined;
}> = ({ location, divergentVariantId }) => (
  <Card className="group relative overflow-hidden py-0 hover:shadow-lg transition-shadow">
    <Link
      to="/locations/$locationId"
      params={{ locationId: location.id }}
      aria-label={location.name}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="aspect-video bg-muted relative overflow-hidden">
        {location.referenceImageUrl ? (
          <AppImage
            src={location.referenceImageUrl}
            alt={location.name}
            width={320}
            height={180}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2">
            <MapPin className="h-12 w-12 text-muted-foreground/30" />
            {location.referenceStatus === 'generating' && (
              <p className="text-xs text-muted-foreground">Drawing sheet…</p>
            )}
            {location.referenceStatus === 'failed' && (
              <p className="text-xs text-destructive">Sheet failed</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 p-4">
        <h3 className="font-semibold text-base line-clamp-1">
          {location.name}
        </h3>
        <p className="text-xs text-muted-foreground line-clamp-1">
          {locationUseLine(location.sequences)}
        </p>
        {location.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {location.description}
          </p>
        )}
      </div>
    </Link>

    {divergentVariantId && (
      <div className="absolute right-2 top-2 z-10" role="presentation">
        <SheetStalenessBanners
          density="corner-dot"
          entityType="location"
          divergentVariantId={divergentVariantId}
        />
      </div>
    )}
  </Card>
);
