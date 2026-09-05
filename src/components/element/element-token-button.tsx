/**
 * The token bar on an element tile: shows the element's UPPERCASE token and
 * opens a small popover to rename it (#1079). The caller supplies the commit —
 * draft mode rewrites local state, persisted mode calls the rename server fn
 * (which cascades through script + shots). Rejections from `onRename` are
 * surfaced inline in the popover.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { deriveTokenFromFilename } from '@/shared/sequence-elements/derive-token';
import { Pencil } from 'lucide-react';
import { useRef, useState } from 'react';

export const ElementTokenButton: React.FC<{
  token: string;
  /** Commit the (already normalized) new token. Reject to show the error inline. */
  onRename: (nextToken: string) => Promise<void>;
}> = ({ token, onRename }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(token);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same normalization the rename server fn applies, previewed live.
  const normalized = deriveTokenFromFilename(value);
  const isUnchanged = normalized === token;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setValue(token);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isUnchanged) {
      setOpen(false);
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      await onRename(normalized);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Rename ${token}`}
          className="absolute bottom-0 left-0 right-0 flex min-h-6 cursor-pointer items-center gap-1 bg-background/90 px-1.5 py-0.5 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
            {token}
          </span>
          <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-2"
        >
          <p className="text-sm font-medium">Rename element</p>
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              if (error) setError(null);
            }}
            maxLength={100}
            placeholder="ELEMENT_NAME"
            className="font-mono"
            aria-invalid={!!error}
            aria-describedby={
              error ? 'token-rename-error' : 'token-rename-hint'
            }
          />
          <p id="token-rename-hint" className="text-xs text-muted-foreground">
            Saved as <span className="font-mono">{normalized}</span>
          </p>
          {error && (
            <p
              id="token-rename-error"
              className="text-xs text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={isSaving || isUnchanged}>
              {isSaving ? 'Renaming…' : 'Save'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
};
