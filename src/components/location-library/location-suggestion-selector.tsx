/**
 * Location Suggestion Selector
 *
 * Multi-select component for suggesting locations during sequence creation.
 * Shows selected locations as thumbnails with a picker dialog for selection.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useLibraryLocations } from '@/hooks/use-sequence-locations';
import type { LibraryLocation } from '@/lib/db/schema';
import { AddLocationDialog } from '@/components/location-library/add-location-dialog';
import { cn } from '@/shared/utils';
import { Check, MapPin, Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import { AppImage } from '@/components/ui/app-image';

type LocationSuggestionSelectorProps = {
  selectedLocationIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
};

type LocationPickerCardProps = {
  location: LibraryLocation;
  isSelected: boolean;
  onClick: () => void;
};

const LocationPickerCard: React.FC<LocationPickerCardProps> = ({
  location,
  isSelected,
  onClick,
}) => {
  const imageUrl = location.referenceImageUrl;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors focus:outline-none focus:ring-2 focus:ring-primary',
        isSelected ? 'bg-primary/10 ring-2 ring-primary' : 'hover:bg-muted'
      )}
    >
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
        {imageUrl ? (
          <AppImage
            src={imageUrl}
            alt={location.name}
            width={160}
            height={160}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MapPin className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}
      </div>
      <span className="text-sm font-medium truncate w-full">
        {location.name}
      </span>
      {location.isPublic && (
        <div className="absolute left-2 top-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
          System
        </div>
      )}
      {isSelected && (
        <div className="absolute right-2 top-2 rounded-full bg-primary p-1">
          <Check className="h-3 w-3 text-primary-foreground" />
        </div>
      )}
    </button>
  );
};

type LocationThumbnailProps = {
  location: LibraryLocation;
  onRemove?: () => void;
};

const LocationThumbnail: React.FC<LocationThumbnailProps> = ({
  location,
  onRemove,
}) => {
  const imageUrl = location.referenceImageUrl;

  return (
    <div className="group relative">
      <div className="h-10 w-14 overflow-hidden rounded border-2 border-primary bg-muted">
        {imageUrl ? (
          <AppImage
            src={imageUrl}
            alt={location.name}
            width={160}
            height={160}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MapPin className="h-4 w-4 text-muted-foreground/30" />
          </div>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

export const LocationSuggestionSelector: React.FC<
  LocationSuggestionSelectorProps
> = ({ selectedLocationIds, onSelectionChange, disabled = false }) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { data: locationList, isLoading } = useLibraryLocations();

  // Get selected location objects
  const selectedLocations =
    locationList?.filter((l) => selectedLocationIds.includes(l.id)) ?? [];

  // Filter locations by search query
  const filteredLocations = locationList?.filter((l) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      l.name.toLowerCase().includes(query) ||
      l.description?.toLowerCase().includes(query)
    );
  });

  const toggleLocation = (locationId: string) => {
    if (selectedLocationIds.includes(locationId)) {
      onSelectionChange(selectedLocationIds.filter((id) => id !== locationId));
    } else {
      onSelectionChange([...selectedLocationIds, locationId]);
    }
  };

  const removeLocation = (locationId: string) => {
    onSelectionChange(selectedLocationIds.filter((id) => id !== locationId));
  };

  // Auto-select a freshly added location so the user doesn't have to find and
  // re-pick it in the grid after the dialog closes.
  const handleLocationCreated = (location: { id: string }) => {
    if (selectedLocationIds.includes(location.id)) return;
    onSelectionChange([...selectedLocationIds, location.id]);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Locations button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsDialogOpen(true)}
          disabled={disabled}
          className="gap-2 text-muted-foreground"
        >
          <MapPin className="h-4 w-4" />
          <span>Locations</span>
        </Button>

        {/* Selected location thumbnails */}
        {selectedLocations.length > 0 && (
          <div className="flex items-center gap-1">
            {selectedLocations.slice(0, 3).map((location) => (
              <LocationThumbnail
                key={location.id}
                location={location}
                onRemove={() => removeLocation(location.id)}
              />
            ))}
            {selectedLocations.length > 3 && (
              <div className="flex h-10 w-14 items-center justify-center rounded border-2 border-dashed border-muted-foreground/50 bg-muted text-xs font-medium text-muted-foreground">
                +{selectedLocations.length - 3}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Multi-select dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDialogOpen(false);
            }}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Select Locations</DialogTitle>
              <DialogDescription>
                Pick locations here only when you want a specific reference. Any
                locations you don't pre-pick are auto-extracted from your script
                and given AI-generated reference shots.
              </DialogDescription>
            </DialogHeader>

            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search locations…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Locations grid */}
            <ScrollArea className="h-[400px]">
              {isLoading ? (
                <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex flex-col items-center gap-2 p-3"
                    >
                      <Skeleton className="aspect-video w-full rounded-lg" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  ))}
                </div>
              ) : !filteredLocations || filteredLocations.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                  <MapPin className="h-12 w-12 text-muted-foreground/30" />
                  <p className="mt-4 text-sm text-muted-foreground">
                    {searchQuery
                      ? 'No locations matching your search'
                      : 'Your location library is empty'}
                  </p>
                  {!searchQuery && (
                    <AddLocationDialog
                      onCreated={handleLocationCreated}
                      trigger={
                        <Button variant="outline" size="sm" className="mt-3">
                          <Plus className="mr-2 h-4 w-4" />
                          Add Location
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
                  {filteredLocations.map((location) => (
                    <LocationPickerCard
                      key={location.id}
                      location={location}
                      isSelected={selectedLocationIds.includes(location.id)}
                      onClick={() => toggleLocation(location.id)}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Footer */}
            <div className="flex justify-between">
              <AddLocationDialog
                onCreated={handleLocationCreated}
                trigger={
                  <Button variant="outline" size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Location
                  </Button>
                }
              />
              <div className="flex flex-col items-center gap-1">
                <Button type="submit">
                  {selectedLocationIds.length > 0
                    ? `Use ${selectedLocationIds.length} location${selectedLocationIds.length === 1 ? '' : 's'}`
                    : 'Continue'}
                </Button>
                <span
                  className={cn(
                    'text-[10px] text-muted-foreground',
                    selectedLocationIds.length > 0 && 'invisible'
                  )}
                >
                  without picking locations
                </span>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
