/**
 * Pencil-popover rename for the sequence title (#1108 Phase 4), following the
 * element token rename pattern (#1079). Enter saves, Escape closes the
 * popover (cancel), errors surface inline.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useRenameSequence } from '@/hooks/use-sequences';
import { errorMessage } from '@/lib/errors';
import { Pencil } from 'lucide-react';
import { useRef, useState } from 'react';

export const RenameSequenceButton: React.FC<{
  sequenceId: string;
  title: string;
}> = ({ sequenceId, title }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameSequence = useRenameSequence(sequenceId);

  const trimmed = value.trim();
  const isUnchanged = trimmed === title;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setValue(title);
      setError(null);
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isUnchanged || trimmed.length === 0) {
      setOpen(false);
      return;
    }
    setError(null);
    renameSequence.mutate(trimmed, {
      onSuccess: () => setOpen(false),
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={`Rename sequence ${title}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <p className="text-sm font-medium">Rename sequence</p>
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              if (error) setError(null);
            }}
            maxLength={500}
            placeholder="Sequence title"
            aria-invalid={!!error}
            aria-describedby={error ? 'sequence-rename-error' : undefined}
          />
          {error && (
            <p
              id="sequence-rename-error"
              className="text-xs text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={
                renameSequence.isPending || isUnchanged || trimmed.length === 0
              }
            >
              {renameSequence.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
};
