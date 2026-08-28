import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePromoteSequenceStyle } from '@/hooks/use-styles';
import type { Style } from '@/types/database';
import { useId } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const promoteFormSchema = z.object({
  name: z.string().trim().min(1, 'Give the style a name').max(255),
});

type PromoteStyleDialogProps = {
  style: Style;
  sequenceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Add a sequence's automatic style to the team library (#1213). The derived
 * name is the default; the library's slug-uniqueness rule can reject it, in
 * which case the server's message names the clash.
 */
export function PromoteStyleDialog({
  style,
  sequenceId,
  open,
  onOpenChange,
}: PromoteStyleDialogProps) {
  const nameId = useId();
  const promote = usePromoteSequenceStyle();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = promoteFormSchema.safeParse(
      Object.fromEntries(new FormData(event.currentTarget))
    );
    if (!parsed.success) return;
    promote.mutate(
      { sequenceId, name: parsed.data.name },
      {
        onSuccess: (promoted) => {
          toast.success(`“${promoted.name}” added to your style library`);
          onOpenChange(false);
        },
        onError: (error) => {
          toast.error('Could not add the style to your library', {
            description: error.message,
          });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add style to library</DialogTitle>
            <DialogDescription>
              This style was derived from the script and only lives on this
              sequence. Adding it to your library makes it available to every
              new sequence.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Style name</Label>
            <Input
              id={nameId}
              name="name"
              defaultValue={style.name}
              required
              maxLength={255}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={promote.isPending}>
              {promote.isPending ? 'Adding…' : 'Add to library'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
