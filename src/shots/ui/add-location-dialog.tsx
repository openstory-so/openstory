import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { Label } from '@/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Textarea } from '@/ui/shadcn/textarea';
import { AppImage } from '@/ui/shadcn/app-image';
import { locationUseLine } from '@/cast/ui/locations/location-picker-dialog';
import {
  useAttachLocation,
  useCreateSequenceLocation,
} from '@/cast/ui/use-sequence-locations';
import { useTeamLocationList } from '@/cast/ui/use-team-locations';
import { errorMessage } from '@/platform/errors';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(['interior', 'exterior', 'both']),
  description: z.string().max(2000),
});

/**
 * The locations panel's one way in. It opens on the team's locations
 * (#1695): picking one is the same attach the `@` picker makes, one link,
 * nothing copied. New location swaps the list for the manual create (#1108
 * Phase 2): name and type plus an optional description; the rest of the
 * bible and the sheet are on the location's page.
 */
export const AddLocationDialog: React.FC<{
  sequenceId: string;
  /** Locations the sequence already uses: not offered again. */
  usedLocationIds: ReadonlySet<string>;
}> = ({ sequenceId, usedLocationIds }) => {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const { data: teamLocations } = useTeamLocationList(open);
  const attach = useAttachLocation();
  const createLocation = useCreateSequenceLocation();

  const q = query.trim().toLowerCase();
  const offered = teamLocations?.filter(
    (l) => !usedLocationIds.has(l.id) && l.name.toLowerCase().includes(q)
  );

  const close = () => {
    setOpen(false);
    setCreating(false);
    setQuery('');
  };

  const add = (location: { id: string; name: string }) =>
    attach.mutate(
      { sequenceId, locationId: location.id },
      {
        onSuccess: () => {
          close();
          toast.success(`Added ${location.name}`);
        },
        onError: (error) =>
          toast.error(`Could not add ${location.name}`, {
            description: errorMessage(error),
          }),
      }
    );

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = createLocationSchema.safeParse(
      Object.fromEntries(new FormData(event.currentTarget))
    );
    if (!result.success) {
      toast.error('Check the location fields', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    createLocation.mutate(
      { sequenceId, ...result.data },
      {
        onSuccess: (location) => {
          close();
          toast.success(`Added ${location.name}`);
        },
        onError: (error) =>
          toast.error('Failed to add location', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Add Location
        </Button>
      </DialogTrigger>
      {creating ? (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New location</DialogTitle>
            <DialogDescription>
              The rest of the bible and the sheet are on its page.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-location-name">Name</Label>
              <Input id="new-location-name" name="name" required />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-location-type">Type</Label>
              <Select
                name="type"
                defaultValue="interior"
                items={{
                  interior: 'Interior',
                  exterior: 'Exterior',
                  both: 'Interior/Exterior',
                }}
              >
                <SelectTrigger id="new-location-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interior">Interior</SelectItem>
                  <SelectItem value="exterior">Exterior</SelectItem>
                  <SelectItem value="both">Interior/Exterior</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-location-description">
                Description (optional)
              </Label>
              <Textarea
                id="new-location-description"
                name="description"
                rows={3}
              />
            </div>
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreating(false)}
              >
                Back to locations
              </Button>
              <Button type="submit" disabled={createLocation.isPending}>
                {createLocation.isPending ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add location</DialogTitle>
            <DialogDescription>
              Adds the location with its sheet. Later edits reach this sequence.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                type="search"
                placeholder="Search locations…"
                aria-label="Search locations"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreating(true)}
              >
                New location
              </Button>
            </div>
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {!offered &&
                [0, 1, 2].map((i) => (
                  <li key={i}>
                    <Skeleton className="h-12 w-full" />
                  </li>
                ))}
              {offered?.length === 0 && (
                <li className="py-6 text-center text-sm text-muted-foreground">
                  {q ? 'No location matches' : 'No other locations yet'}
                </li>
              )}
              {offered?.map((location) => {
                const pending =
                  attach.isPending &&
                  attach.variables.locationId === location.id;
                return (
                  <li key={location.id}>
                    <button
                      type="button"
                      disabled={attach.isPending}
                      onClick={() => add(location)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                        {location.referenceImageUrl && (
                          <AppImage
                            src={location.referenceImageUrl}
                            alt=""
                            width={128}
                            height={80}
                            className="h-full w-full object-cover"
                          />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">
                          {pending ? 'Adding…' : location.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {locationUseLine(location.sequences)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};
