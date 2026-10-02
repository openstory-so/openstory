import { BibleField } from '@/cast/ui/bible-field';
import { Button } from '@/ui/shadcn/button';
import { Label } from '@/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { useUpdateSequenceLocation } from '@/cast/ui/use-sequence-locations';
import type { SequenceLocationWithReference } from '@/platform/server/db/schema';
import { errorMessage } from '@/platform/errors';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

const locationFormSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(['interior', 'exterior', 'both']),
  description: z.string().max(2000),
  architecturalStyle: z.string().max(2000),
  keyFeatures: z.string().max(2000),
  ambiance: z.string().max(2000),
});

/**
 * Editable location bible (#1108 Phase 2). Uncontrolled inputs seeded from
 * the row (key the form by location id at the call site); one Save persists
 * every field — an emptied input clears that field server-side. Prompt/sheet
 * staleness follows by hash derivation.
 */
export const LocationBibleForm: React.FC<{
  sequenceId: string;
  location: SequenceLocationWithReference;
}> = ({ sequenceId, location }) => {
  const updateLocation = useUpdateSequenceLocation();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = locationFormSchema.safeParse(
      Object.fromEntries(new FormData(event.currentTarget))
    );
    if (!result.success) {
      // See the character twin: without this, a too-long field makes Save
      // look like a no-op.
      toast.error('Check the location fields', {
        description: result.error.issues[0]?.message,
      });
      return;
    }
    updateLocation.mutate(
      { sequenceId, locationDbId: location.id, ...result.data },
      {
        onSuccess: () => toast.success('Location saved'),
        onError: (error) =>
          toast.error('Failed to save location', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <BibleField
        idPrefix="location"
        label="Name"
        name="name"
        defaultValue={location.name}
        required
      />
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="location-type"
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Type
          </Label>
          <Select
            name="type"
            defaultValue={
              location.type === 'exterior' || location.type === 'both'
                ? location.type
                : 'interior'
            }
            items={{
              interior: 'Interior',
              exterior: 'Exterior',
              both: 'Interior/Exterior',
            }}
          >
            <SelectTrigger id="location-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="interior">Interior</SelectItem>
              <SelectItem value="exterior">Exterior</SelectItem>
              <SelectItem value="both">Interior/Exterior</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <BibleField
        idPrefix="location"
        label="Description"
        name="description"
        defaultValue={location.description}
        textarea
      />
      <BibleField
        idPrefix="location"
        label="Architectural Style"
        name="architecturalStyle"
        defaultValue={location.architecturalStyle}
      />
      <BibleField
        idPrefix="location"
        label="Key Features"
        name="keyFeatures"
        defaultValue={location.keyFeatures}
        textarea
      />
      <BibleField
        idPrefix="location"
        label="Ambiance"
        name="ambiance"
        defaultValue={location.ambiance}
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={updateLocation.isPending}>
          {updateLocation.isPending && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {updateLocation.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
};
