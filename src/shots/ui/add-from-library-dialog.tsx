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
import { AppImage } from '@/ui/shadcn/app-image';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  useAttachLibraryCharacter,
  useLibraryCharacters,
} from '@/cast/ui/use-team-characters';
import { errorMessage } from '@/platform/errors';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Cast a team character into this sequence from the cast panel (#2050),
 * with no script change. The same attach the `@` picker makes: one link
 * pinning her current version, every look, nothing copied.
 */
export const AddFromLibraryDialog: React.FC<{
  sequenceId: string;
  /** Characters the sequence already casts: not offered again. */
  castCharacterIds: ReadonlySet<string>;
}> = ({ sequenceId, castCharacterIds }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data: library } = useLibraryCharacters(open);
  const attach = useAttachLibraryCharacter();

  const q = query.trim().toLowerCase();
  const offered = library?.filter(
    (c) => !castCharacterIds.has(c.id) && c.name.toLowerCase().includes(q)
  );

  const add = (character: { id: string; name: string }) =>
    attach.mutate(
      { sequenceId, characterId: character.id },
      {
        onSuccess: () => {
          setOpen(false);
          toast.success(`Added ${character.name}`);
        },
        onError: (error) =>
          toast.error(`Could not add ${character.name}`, {
            description: errorMessage(error),
          }),
      }
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Add existing character
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add existing character</DialogTitle>
          <DialogDescription>
            Adds the character at its current version, with every look. Sheets
            are drawn in this sequence's style.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            type="search"
            placeholder="Search characters…"
            aria-label="Search characters"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {!offered &&
              [0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton className="h-12 w-full" />
                </li>
              ))}
            {offered?.length === 0 && (
              <li className="py-6 text-center text-sm text-muted-foreground">
                {q ? 'No character matches' : 'No other characters yet'}
              </li>
            )}
            {offered?.map((character) => {
              const pending =
                attach.isPending &&
                attach.variables?.characterId === character.id;
              return (
                <li key={character.id}>
                  <button
                    type="button"
                    disabled={attach.isPending}
                    onClick={() => add(character)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                      {character.sequences[0]?.sheetImageUrl && (
                        <AppImage
                          src={character.sequences[0].sheetImageUrl}
                          alt=""
                          width={40}
                          height={40}
                          className="h-full w-full object-cover"
                        />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">
                        {pending ? 'Adding…' : character.name}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {character.sequences.length === 0
                          ? 'In no sequence'
                          : character.sequences.length === 1
                            ? `In ${character.sequences[0]?.title}`
                            : `In ${character.sequences.length} sequences`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
};
