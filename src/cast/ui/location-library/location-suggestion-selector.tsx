/**
 * Where a new sequence is set (#1695): one button, one picker of the team's
 * locations. A pick is a suggestion: analysis matches the script's places
 * against the picks and links the sequence to the ones that match.
 */

import type { TeamLocation } from '@/cast/server/db/locations';
import { NewLocationDialog } from '@/cast/ui/location-library/new-location-dialog';
import { AppImage } from '@/ui/shadcn/app-image';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useHydrated } from '@/ui/use-hydrated';
import { cn } from '@/ui/utils';
import { Check, MapPin, X } from 'lucide-react';
import { useState } from 'react';

type LocationSuggestionSelectorProps = {
  /** The team's locations; undefined while they load. */
  locations: readonly TeamLocation[] | undefined;
  failed: boolean;
  /** Signed out there is no team, so nothing to pick. */
  signedOut: boolean;
  selectedLocationIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  disabled: boolean;
};

const Picture: React.FC<{ location: TeamLocation; iconClass: string }> = ({
  location,
  iconClass,
}) =>
  location.referenceImageUrl ? (
    <AppImage
      src={location.referenceImageUrl}
      alt={location.name}
      width={320}
      height={180}
      className="h-full w-full object-cover"
    />
  ) : (
    <div className="flex h-full w-full items-center justify-center">
      <MapPin className={cn(iconClass, 'text-muted-foreground/30')} />
    </div>
  );

export const LocationSuggestionSelector: React.FC<
  LocationSuggestionSelectorProps
> = ({
  locations,
  failed,
  signedOut,
  selectedLocationIds,
  onSelectionChange,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Server-rendered before its handler exists: a click then does nothing.
  const hydrated = useHydrated();

  const selected = (locations ?? []).filter((l) =>
    selectedLocationIds.includes(l.id)
  );
  // A pick the list no longer has (deleted since, or a draft from another
  // team). Shown and removable, not dropped.
  const gone = locations
    ? selectedLocationIds.filter((id) => !locations.some((l) => l.id === id))
    : [];
  const shown = locations?.filter((l) =>
    l.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const toggle = (id: string) =>
    onSelectionChange(
      selectedLocationIds.includes(id)
        ? selectedLocationIds.filter((picked) => picked !== id)
        : [...selectedLocationIds, id]
    );

  const newLocation = (
    <NewLocationDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          New location
        </Button>
      }
      // Picked as it is made, so it need not be found in the grid.
      onCreated={(location) => {
        if (!selectedLocationIds.includes(location.id)) {
          onSelectionChange([...selectedLocationIds, location.id]);
        }
      }}
    />
  );

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={disabled || !hydrated}
          className="text-muted-foreground"
        >
          Locations
        </Button>

        {selected.length + gone.length > 0 && (
          <div className="flex items-center gap-1">
            {gone.map((id) => (
              <div key={id} className="group relative">
                <div className="flex h-10 w-14 items-center justify-center overflow-hidden rounded border-2 border-dashed border-destructive bg-muted">
                  <MapPin className="h-4 w-4 text-muted-foreground/30" />
                </div>
                <button
                  type="button"
                  aria-label="Remove deleted location"
                  onClick={() => toggle(id)}
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {selected.slice(0, 3).map((location) => (
              <div key={location.id} className="group relative">
                <div className="h-10 w-14 overflow-hidden rounded border-2 border-primary bg-muted">
                  <Picture location={location} iconClass="h-4 w-4" />
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${location.name}`}
                  onClick={() => toggle(location.id)}
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {selected.length > 3 && (
              <div className="flex h-10 w-14 items-center justify-center rounded border-2 border-dashed border-muted-foreground/50 bg-muted text-xs font-medium text-muted-foreground">
                +{selected.length - 3}
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch('');
        }}
      >
        <DialogContent className="max-w-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Locations</DialogTitle>
              <DialogDescription>
                Places the script names are matched to your picks. The rest are
                made new.
              </DialogDescription>
            </DialogHeader>

            <Input
              type="search"
              aria-label="Search locations"
              placeholder="Search locations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Enter would submit the form and close the picker mid-search.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />

            <ScrollArea className="h-[min(400px,40dvh)]">
              {failed ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Could not load locations.
                </p>
              ) : !shown ? (
                <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex flex-col gap-2 p-3">
                      <Skeleton className="aspect-video w-full rounded-lg" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  ))}
                </div>
              ) : shown.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {search.trim()
                    ? 'No location matches.'
                    : signedOut
                      ? 'Sign in to pick your locations.'
                      : 'No locations yet.'}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
                  {shown.map((location) => {
                    const isSelected = selectedLocationIds.includes(
                      location.id
                    );
                    return (
                      <button
                        key={location.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => toggle(location.id)}
                        className={cn(
                          'relative flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isSelected
                            ? 'bg-primary/10 ring-2 ring-primary'
                            : 'hover:bg-muted'
                        )}
                      >
                        <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
                          <Picture location={location} iconClass="h-12 w-12" />
                        </div>
                        <span className="w-full truncate text-sm font-medium">
                          {location.name}
                        </span>
                        {isSelected && (
                          <div className="absolute right-2 top-2 rounded-full bg-primary p-1">
                            <Check className="h-3 w-3 text-primary-foreground" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>

            <div className="flex items-center justify-between">
              {signedOut ? <span /> : newLocation}
              <Button type="submit">
                {selectedLocationIds.length > 0
                  ? `Use ${selectedLocationIds.length}`
                  : 'Continue'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
