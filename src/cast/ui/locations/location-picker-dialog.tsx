import type { TeamLocation } from '@/cast/server/db/locations';
import { useTeamLocationList } from '@/cast/ui/use-team-locations';
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
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { AppImage } from '@/ui/shadcn/app-image';

/** Which sequences use a location, in a line. */
export function locationUseLine(sequences: TeamLocation['sequences']): string {
  const [latest] = sequences;
  if (!latest) return 'In no sequence';
  if (sequences.length === 1) return `In ${latest.title}`;
  return `Used in ${sequences.length} sequences`;
}

/**
 * Pick the team location that replaces this one in the sequence (#1695).
 * Only locations with a sheet are offered: the shots set here re-render
 * from it, and Replace draws none.
 */
export const LocationPickerDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (location: TeamLocation) => void;
  /** Locations the sequence already uses, this one included: not offered. */
  excludeLocationIds: ReadonlySet<string>;
}> = ({ open, onOpenChange, onSelect, excludeLocationIds }) => {
  const { data: locations } = useTeamLocationList(open);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const offered = locations?.filter(
    (location) =>
      location.referenceImageUrl &&
      !excludeLocationIds.has(location.id) &&
      location.name.toLowerCase().includes(q)
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Replace location</DialogTitle>
          <DialogDescription>
            The sequence uses the one you pick instead. Its shots re-render.
          </DialogDescription>
        </DialogHeader>

        <Input
          type="search"
          placeholder="Search locations…"
          aria-label="Search locations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <ScrollArea className="h-[400px]">
          {!offered ? (
            <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2 p-3">
                  <Skeleton className="aspect-video w-full rounded-lg" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : offered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {q ? 'No location matches' : 'No other locations with a sheet'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
              {offered.map((location) => (
                <button
                  key={location.id}
                  type="button"
                  onClick={() => {
                    onSelect(location);
                    onOpenChange(false);
                    setQuery('');
                  }}
                  className="flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
                    {location.referenceImageUrl ? (
                      <AppImage
                        src={location.referenceImageUrl}
                        alt=""
                        width={320}
                        height={180}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <MapPin className="h-12 w-12 text-muted-foreground/30" />
                      </div>
                    )}
                  </div>
                  <span className="w-full truncate text-sm font-medium">
                    {location.name}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {locationUseLine(location.sequences)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
