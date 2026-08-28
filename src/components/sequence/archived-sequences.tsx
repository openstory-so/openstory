/**
 * Collapsed "Archived" strip under the sequences list (#1108 Phase 4):
 * renders only when the team has archived sequences, expands to a compact
 * row list with per-row Unarchive (restores the recorded prior status).
 */

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  useArchivedSequences,
  useUnarchiveSequence,
} from '@/hooks/use-sequences';
import { errorMessage } from '@/lib/errors';
import { formatDistanceToNow } from '@/lib/format-date';
import { ArchiveRestore, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export const ArchivedSequences: React.FC = () => {
  const [open, setOpen] = useState(false);
  const { data: archived } = useArchivedSequences();
  const unarchive = useUnarchiveSequence();

  if (!archived || archived.length === 0) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="shrink-0 rounded-lg border"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start gap-2 text-sm text-muted-foreground"
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <span>Archived ({archived.length})</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 px-3 pb-3">
          {archived.map((sequence) => (
            <li
              key={sequence.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {sequence.title || 'Untitled Sequence'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Archived {formatDistanceToNow(new Date(sequence.updatedAt))}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={unarchive.isPending}
                onClick={() =>
                  unarchive.mutate(sequence.id, {
                    onSuccess: () =>
                      toast.success(`Restored ${sequence.title || 'sequence'}`),
                    onError: (error) =>
                      toast.error('Failed to unarchive sequence', {
                        description: errorMessage(error),
                      }),
                  })
                }
              >
                <ArchiveRestore className="mr-2 h-4 w-4" />
                {unarchive.isPending ? 'Restoring…' : 'Unarchive'}
              </Button>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
};
