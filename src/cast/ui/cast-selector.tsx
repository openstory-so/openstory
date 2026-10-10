/**
 * Who a new sequence is cast with (#2017): one button, one picker, two tabs.
 * A character is added directly: every pick is cast, whether or not the
 * script names it yet. Talent is a suggestion: analysis decides which of the
 * script's characters each one plays.
 */

import { talentSquareImageClassName } from '@/cast/talent-preview';
import {
  TALENT_CASTING_HINT,
  TalentAvatars,
  TalentPickerPanel,
} from '@/cast/ui/talent/talent-suggestion-selector';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs';
import type { TeamCharacter } from '@/cast/server/db/characters';
import { useHydrated } from '@/ui/use-hydrated';
import { AppImage } from '@/ui/shadcn/app-image';
import { Button } from '@/ui/shadcn/button';
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
import { cn } from '@/ui/utils';
import { Link } from '@tanstack/react-router';
import { Check, User, X } from 'lucide-react';
import { useState } from 'react';

type CastSelectorProps = {
  /** The team's characters; undefined while they load. */
  characters: readonly TeamCharacter[] | undefined;
  failed: boolean;
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  selectedTalentIds: string[];
  onTalentChange: (ids: string[]) => void;
  disabled: boolean;
};

const Picture: React.FC<{ character: TeamCharacter; iconClass: string }> = ({
  character,
  iconClass,
}) => {
  // The portrait drawn from the sheet; a sheet from before portraits is cropped.
  const portraitUrl = character.sheetPortraitUrl;
  const url = portraitUrl ?? character.sheetImageUrl;
  return url ? (
    <AppImage
      src={url}
      alt={character.name}
      width={portraitUrl ? 160 : 640}
      height={160}
      className={talentSquareImageClassName(!portraitUrl)}
    />
  ) : (
    <div className="flex h-full w-full items-center justify-center">
      <User className={cn(iconClass, 'text-muted-foreground/30')} />
    </div>
  );
};

export const CastSelector: React.FC<CastSelectorProps> = ({
  characters,
  failed,
  selectedIds,
  onSelectionChange,
  selectedTalentIds,
  onTalentChange,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  // Server-rendered before its handler exists: a click then does nothing.
  // Disabled until hydrated, like the library filters.
  const hydrated = useHydrated();
  const [search, setSearch] = useState('');

  const selected = (characters ?? []).filter((c) => selectedIds.includes(c.id));
  const shown = characters?.filter((c) =>
    c.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const toggle = (id: string) =>
    onSelectionChange(
      selectedIds.includes(id)
        ? selectedIds.filter((picked) => picked !== id)
        : [...selectedIds, id]
    );

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={disabled || !hydrated}
          className="text-muted-foreground"
        >
          Cast
        </Button>
        {selected.length > 0 && (
          <div className="flex items-center -space-x-2">
            {selected.slice(0, 4).map((character) => (
              <div key={character.id} className="group relative">
                <div className="h-10 w-10 overflow-hidden rounded-full border-2 border-primary bg-muted">
                  <Picture character={character} iconClass="h-5 w-5" />
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${character.name}`}
                  onClick={() => toggle(character.id)}
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {selected.length > 4 && (
              <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/50 bg-muted text-xs font-medium text-muted-foreground">
                +{selected.length - 4}
              </div>
            )}
          </div>
        )}
        <TalentAvatars
          selectedTalentIds={selectedTalentIds}
          onSelectionChange={onTalentChange}
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Cast</DialogTitle>
              <DialogDescription>
                Add your characters, or suggest talent for the script's own.
              </DialogDescription>
            </DialogHeader>
            <Tabs defaultValue="characters" className="flex flex-col gap-4">
              <TabsList>
                <TabsTrigger value="characters">Characters</TabsTrigger>
                <TabsTrigger value="talent">Talent</TabsTrigger>
              </TabsList>
              <TabsContent value="talent" className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  {TALENT_CASTING_HINT}
                </p>
                <TalentPickerPanel
                  selectedTalentIds={selectedTalentIds}
                  onSelectionChange={onTalentChange}
                />
              </TabsContent>
              <TabsContent value="characters" className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  Each one joins this sequence with its looks, sheets and voice.
                  Characters the script adds are made new.
                </p>
                <Input
                  type="search"
                  aria-label="Search characters"
                  placeholder="Search characters…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <ScrollArea className="h-[400px]">
                  {failed ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      Could not load characters.
                    </p>
                  ) : !shown ? (
                    <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="flex flex-col gap-2 p-3">
                          <Skeleton className="aspect-square w-full rounded-lg" />
                          <Skeleton className="h-4 w-3/4" />
                        </div>
                      ))}
                    </div>
                  ) : shown.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-12 text-center">
                      <p className="text-sm text-muted-foreground">
                        {search.trim()
                          ? 'No character matches.'
                          : 'No characters yet.'}
                      </p>
                      {!search.trim() && (
                        <Button asChild variant="outline" size="sm">
                          <Link to="/characters">Open Characters</Link>
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
                      {shown.map((character) => {
                        const isSelected = selectedIds.includes(character.id);
                        return (
                          <button
                            key={character.id}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => toggle(character.id)}
                            className={cn(
                              'relative flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              isSelected
                                ? 'bg-primary/10 ring-2 ring-primary'
                                : 'hover:bg-muted'
                            )}
                          >
                            <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
                              <Picture
                                character={character}
                                iconClass="h-12 w-12"
                              />
                            </div>
                            <span className="w-full truncate text-sm font-medium">
                              {character.name}
                            </span>
                            {isSelected && (
                              <div className="absolute right-2 top-2 rounded-full bg-primary p-1">
                                <Check className="h-3 w-3 text-primary-foreground" />
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </ScrollArea>
              </TabsContent>
            </Tabs>
            <div className="flex justify-end">
              <Button type="submit">
                {selectedIds.length + selectedTalentIds.length > 0
                  ? `Cast ${selectedIds.length + selectedTalentIds.length}`
                  : 'Continue'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
