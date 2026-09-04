import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCreateSequenceLocation } from '@/hooks/use-sequence-locations';
import { errorMessage } from '@/lib/errors';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(['interior', 'exterior', 'both']),
  description: z.string().max(2000),
});

/**
 * Manual location create (#1108 Phase 2) — name/type plus an optional
 * description; the full bible is edited on the location's detail page, and
 * the reference image comes later via recast.
 */
export const AddLocationDialog: React.FC<{ sequenceId: string }> = ({
  sequenceId,
}) => {
  const [open, setOpen] = useState(false);
  const createLocation = useCreateSequenceLocation();

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
          setOpen(false);
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Location
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add location</DialogTitle>
          <DialogDescription>
            Fill in the full bible and generate a reference image from the
            location's detail page.
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
          <div className="flex justify-end">
            <Button type="submit" disabled={createLocation.isPending}>
              {createLocation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {createLocation.isPending ? 'Adding…' : 'Add Location'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
