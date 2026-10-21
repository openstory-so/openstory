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
import { NewCharacterForm } from '@/cast/ui/new-character-form';
import { useCreateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import {
  useAttachLibraryCharacter,
  useLibraryCharacters,
} from '@/cast/ui/use-team-characters';
import { talentSquareImageClassName } from '@/cast/talent-preview';
import { errorMessage } from '@/platform/errors';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * The cast panel's one way in. It opens on the team's characters (#2050):
 * picking one is the same attach the `@` picker makes, one link, every look,
 * nothing copied. New character swaps the list for the manual create (#1108
 * Phase 2): a name, then the character's page beside the inspector.
 */
export const AddCharacterDialog: React.FC<{
  sequenceId: string;
  /** Characters the sequence already casts: not offered again. */
  castCharacterIds: ReadonlySet<string>;
}> = ({ sequenceId, castCharacterIds }) => {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const { data: library } = useLibraryCharacters(open);
  const attach = useAttachLibraryCharacter();
  const createCharacter = useCreateSequenceCharacter();
  const navigate = useNavigate();

  const q = query.trim().toLowerCase();
  const offered = library?.filter(
    (c) => !castCharacterIds.has(c.id) && c.name.toLowerCase().includes(q)
  );

  const close = () => {
    setOpen(false);
    setCreating(false);
    setQuery('');
  };

  const add = (character: { id: string; name: string }) =>
    attach.mutate(
      { sequenceId, characterId: character.id },
      {
        onSuccess: () => {
          close();
          toast.success(`Added ${character.name}`);
        },
        onError: (error) =>
          toast.error(`Could not add ${character.name}`, {
            description: errorMessage(error),
          }),
      }
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Add Character
        </Button>
      </DialogTrigger>
      {creating ? (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New character</DialogTitle>
            <DialogDescription>
              Name it. The rest is filled in on its page.
            </DialogDescription>
          </DialogHeader>
          <NewCharacterForm
            isPending={createCharacter.isPending}
            submitLabel="Create"
            pendingLabel="Creating…"
            onSubmit={(fields) =>
              createCharacter.mutate(
                { sequenceId, ...fields },
                {
                  onSuccess: (character) => {
                    close();
                    void navigate({
                      to: '/sequences/$id/cast/$characterId',
                      params: { id: sequenceId, characterId: character.id },
                      search: true,
                    });
                  },
                  onError: (error) =>
                    toast.error('Failed to add character', {
                      description: errorMessage(error),
                    }),
                }
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setCreating(false)}
          >
            Back to characters
          </Button>
        </DialogContent>
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add character</DialogTitle>
            <DialogDescription>
              Adds the character with every look. Later edits reach this
              sequence.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                type="search"
                placeholder="Search characters…"
                aria-label="Search characters"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreating(true)}
              >
                New character
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
                        {character.sheetImageUrl && (
                          <AppImage
                            src={
                              character.sheetPortraitUrl ??
                              character.sheetImageUrl
                            }
                            alt=""
                            width={40}
                            height={40}
                            className={talentSquareImageClassName(
                              !character.sheetPortraitUrl
                            )}
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
      )}
    </Dialog>
  );
};
