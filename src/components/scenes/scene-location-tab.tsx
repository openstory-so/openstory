/**
 * Locations facet (#986)
 * Selection-scoped location list: `environmentTags: null` shows every
 * location (nothing selected); a tag set shows the union matched across the
 * selected scene(s)/shot. Cards deep-link to the existing edit pages.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import type { SequenceLocation } from '@/lib/db/schema';
import { Link } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';

type SceneLocationTabProps = {
  sequenceId: string;
  /** Selection-derived environment tags; `null` = no filter (whole sequence). */
  environmentTags: string[] | null;
};

/**
 * Match a location to an environment tag.
 * Replicates logic from sequence-locations.ts locationMatchesTag
 */
function locationMatchesTag(
  location: SequenceLocation,
  environmentTag: string
): boolean {
  if (!environmentTag) return false;

  const consistencyTag = (location.consistencyTag ?? '').toLowerCase();
  const locName = location.name.toLowerCase();
  const locId = location.locationId.toLowerCase();
  const envTagLower = environmentTag.toLowerCase();

  // Check if any of the location identifiers match the environment tag
  if (consistencyTag && envTagLower.includes(consistencyTag)) return true;
  if (envTagLower.includes(locName)) return true;
  if (envTagLower.includes(locId)) return true;

  // Also check if location name contains the env tag (reverse match)
  if (locName.includes(envTagLower)) return true;

  return false;
}

function matchLocationsToTags(
  locations: SequenceLocation[],
  environmentTags: string[]
): SequenceLocation[] {
  return locations.filter((location) =>
    environmentTags.some((tag) => locationMatchesTag(location, tag))
  );
}

const typeLabel = (type: SequenceLocation['type']): string | null =>
  type === 'interior'
    ? 'INT'
    : type === 'exterior'
      ? 'EXT'
      : type
        ? 'INT/EXT'
        : null;

const LocationCard: React.FC<{
  location: SequenceLocation;
  sequenceId: string;
}> = ({ location, sequenceId }) => (
  <Link
    to="/sequences/$id/locations/$locationId"
    params={{ id: sequenceId, locationId: location.id }}
    className="group block overflow-hidden rounded-lg bg-card cursor-pointer"
  >
    <div className="relative aspect-video overflow-hidden bg-muted">
      {location.referenceImageUrl ? (
        <img
          src={location.referenceImageUrl}
          alt={location.name}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2">
          <MapPin className="h-8 w-8 text-muted-foreground/20" />
          <p className="text-xs text-muted-foreground">
            {location.referenceStatus === 'generating'
              ? 'Generating reference…'
              : 'No reference image'}
          </p>
        </div>
      )}
      {typeLabel(location.type) && (
        <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
          {typeLabel(location.type)}
        </div>
      )}
    </div>
    <div className="p-3 border-t border-border/50">
      <h3 className="text-sm font-medium">{location.name}</h3>
      {location.description && (
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {location.description}
        </p>
      )}
    </div>
  </Link>
);

export const SceneLocationTab: React.FC<SceneLocationTabProps> = ({
  sequenceId,
  environmentTags,
}) => {
  const { data: locations, isLoading } = useSequenceLocations(sequenceId);

  const scopedLocations = !locations
    ? []
    : environmentTags === null
      ? locations
      : matchLocationsToTags(locations, environmentTags);

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="aspect-video w-full rounded-lg" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  if (scopedLocations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-4 rounded-full bg-muted p-4">
          <MapPin className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {environmentTags === null
            ? 'No locations in this sequence'
            : 'No location for this selection'}
        </p>
        {environmentTags !== null && environmentTags.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground/70">
            Looking for: {environmentTags.join(', ')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>Locations</span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          {scopedLocations.length} location
          {scopedLocations.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {scopedLocations.map((location) => (
          <LocationCard
            key={location.id}
            location={location}
            sequenceId={sequenceId}
          />
        ))}
      </div>
    </div>
  );
};
