import type { OrganizationCharacter } from '@/cast/server/db/characters';
import { useLibraryCharacters } from '@/cast/ui/use-organization-characters';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { User } from 'lucide-react';
import { useState } from 'react';
import { AppImage } from '@/ui/shadcn/app-image';

/** Which sequences use a character, in a line. */
function characterUseLine(
  sequences: OrganizationCharacter['sequences']
): string {
  const [latest] = sequences;
  if (!latest) return 'In no sequence';
  if (sequences.length === 1) return `In ${latest.title}`;
  return `Used in ${sequences.length} sequences`;
}

/**
 * Pick the organization character this slot uses instead (#2249).
 * Characters already in the sequence are offered: picking one drops this slot.
 */
export const CharacterReplacePicker: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (character: OrganizationCharacter) => void;
  /** This slot's character. Not offered. */
  excludeCharacterId: string;
}> = ({ open, onOpenChange, onSelect, excludeCharacterId }) => {
  const { data: characters } = useLibraryCharacters(open);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const offered = characters?.filter(
    (character) =>
      character.id !== excludeCharacterId &&
      character.name.toLowerCase().includes(q)
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Replace character</DialogTitle>
          <DialogDescription>
            The slot keeps its place in the script. The character you pick
            supplies the sheet, looks and voice.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          placeholder="Search characters…"
          aria-label="Search characters"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ScrollArea className="h-[400px]">
          {!offered ? (
            <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2 p-3">
                  <Skeleton className="aspect-square w-full rounded-lg" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : offered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {q ? 'No character matches' : 'No other characters'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3">
              {offered.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => {
                    onSelect(character);
                    onOpenChange(false);
                    setQuery('');
                  }}
                  className="flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
                    {character.sheetImageUrl ? (
                      <AppImage
                        src={
                          character.sheetPortraitUrl ?? character.sheetImageUrl
                        }
                        alt=""
                        width={160}
                        height={160}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <User className="h-12 w-12 text-muted-foreground/30" />
                      </div>
                    )}
                  </div>
                  <span className="w-full truncate text-sm font-medium">
                    {character.name}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {characterUseLine(character.sequences)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

/** Confirm copy. Scenes stay on the slot. Shots go stale. Nothing is copied. */
export function replaceConfirmCopy(
  characterName: string,
  withCharacterName: string
): { title: string; description: string } {
  return {
    title: `Replace ${characterName} with ${withCharacterName}?`,
    description: `Scenes stay on this slot and use ${withCharacterName}'s sheet, looks and voice. Shots that used this slot go stale. Nothing is copied.`,
  };
}

/** Confirm a Replace. Scenes stay on the slot. Shots go stale. Nothing is copied. */
export const CharacterReplaceConfirm: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  characterName: string;
  withCharacterName: string;
  isLoading: boolean;
}> = ({
  open,
  onOpenChange,
  onConfirm,
  characterName,
  withCharacterName,
  isLoading,
}) => {
  const copy = replaceConfirmCopy(characterName, withCharacterName);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading ? 'Replacing…' : 'Replace'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
