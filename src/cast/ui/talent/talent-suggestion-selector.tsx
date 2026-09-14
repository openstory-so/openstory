/**
 * Talent Suggestion Selector
 *
 * Multi-select component for suggesting talent during sequence creation.
 * Shows selected talent as avatars with a picker dialog for selection.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Button } from '@/ui/shadcn/button';
import { Input } from '@/ui/shadcn/input';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useTalent } from '@/cast/ui/use-talent';
import type { TalentWithSheets } from '@/platform/server/db/schema';
import {
  talentSquareImageClassName,
  talentSquarePreview,
} from '@/cast/talent-preview';
import { AddTalentDialog } from '@/cast/ui/talent-library/add-talent-dialog';
import { cn } from '@/ui/utils';
import { Check, Plus, Search, User, Users, X } from 'lucide-react';
import { useState } from 'react';
import { AppImage } from '@/ui/shadcn/app-image';

type TalentSuggestionSelectorProps = {
  selectedTalentIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
};

type TalentPickerCardProps = {
  talent: TalentWithSheets;
  isSelected: boolean;
  onClick: () => void;
};

const TalentPickerCard: React.FC<TalentPickerCardProps> = ({
  talent,
  isSelected,
  onClick,
}) => {
  const preview = talentSquarePreview(talent);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors focus:outline-none focus:ring-2 focus:ring-primary',
        isSelected ? 'bg-primary/10 ring-2 ring-primary' : 'hover:bg-muted'
      )}
    >
      <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
        {preview.url ? (
          <AppImage
            src={preview.url}
            alt={talent.name}
            width={160}
            height={160}
            className={cn(
              talentSquareImageClassName(preview.isSheet),
              'transition-transform duration-300 group-hover:scale-105'
            )}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}
      </div>
      <span className="text-sm font-medium truncate w-full">{talent.name}</span>
      {talent.isPublic && (
        <div className="absolute left-2 top-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
          System
        </div>
      )}
      {isSelected && (
        <div className="absolute right-2 top-2 rounded-full bg-primary p-1">
          <Check className="h-3 w-3 text-primary-foreground" />
        </div>
      )}
    </button>
  );
};

type TalentAvatarProps = {
  talent: TalentWithSheets;
  onRemove?: () => void;
};

const TalentAvatar: React.FC<TalentAvatarProps> = ({ talent, onRemove }) => {
  const preview = talentSquarePreview(talent);

  return (
    <div className="group relative">
      <div className="h-10 w-10 overflow-hidden rounded-full border-2 border-primary bg-muted">
        {preview.url ? (
          <AppImage
            src={preview.url}
            alt={talent.name}
            width={160}
            height={160}
            className={talentSquareImageClassName(preview.isSheet)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-5 w-5 text-muted-foreground/30" />
          </div>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

export const TalentSuggestionSelector: React.FC<
  TalentSuggestionSelectorProps
> = ({ selectedTalentIds, onSelectionChange, disabled = false }) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { data: talentList, isLoading } = useTalent();

  // Get selected talent objects
  const selectedTalent =
    talentList?.filter((t) => selectedTalentIds.includes(t.id)) ?? [];

  // Filter talent by search query
  const filteredTalent = talentList?.filter((t) => {
    if (!searchQuery) return true;
    return t.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const toggleTalent = (talentId: string) => {
    if (selectedTalentIds.includes(talentId)) {
      onSelectionChange(selectedTalentIds.filter((id) => id !== talentId));
    } else {
      onSelectionChange([...selectedTalentIds, talentId]);
    }
  };

  const removeTalent = (talentId: string) => {
    onSelectionChange(selectedTalentIds.filter((id) => id !== talentId));
  };

  // Auto-select freshly added talent so the user doesn't have to find and
  // re-pick it in the grid after the dialog closes.
  const handleTalentCreated = (talent: { id: string }) => {
    if (selectedTalentIds.includes(talent.id)) return;
    onSelectionChange([...selectedTalentIds, talent.id]);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Talent button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsDialogOpen(true)}
          disabled={disabled}
          className="gap-2 text-muted-foreground"
        >
          <Users className="h-4 w-4" />
          <span>Talent</span>
        </Button>

        {/* Selected talent avatars */}
        {selectedTalent.length > 0 && (
          <div className="flex items-center -space-x-2">
            {selectedTalent.slice(0, 4).map((talent) => (
              <TalentAvatar
                key={talent.id}
                talent={talent}
                onRemove={() => removeTalent(talent.id)}
              />
            ))}
            {selectedTalent.length > 4 && (
              <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/50 bg-muted text-xs font-medium text-muted-foreground">
                +{selectedTalent.length - 4}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Multi-select dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDialogOpen(false);
            }}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Select Talent for Casting</DialogTitle>
              <DialogDescription>
                Pick talent here only when you want a specific person cast in a
                role. Any characters you don't pre-cast are auto-extracted from
                your script and given AI-generated portraits.
              </DialogDescription>
            </DialogHeader>

            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search talent…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Talent grid */}
            <ScrollArea className="h-[400px]">
              {isLoading ? (
                <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex flex-col items-center gap-2 p-3"
                    >
                      <Skeleton className="aspect-square w-full rounded-lg" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  ))}
                </div>
              ) : !filteredTalent || filteredTalent.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                  <User className="h-12 w-12 text-muted-foreground/30" />
                  <p className="mt-4 text-sm text-muted-foreground">
                    {searchQuery
                      ? 'No talent matching your search'
                      : 'Your talent library is empty'}
                  </p>
                  {!searchQuery && (
                    <AddTalentDialog
                      onCreated={handleTalentCreated}
                      trigger={
                        <Button variant="outline" size="sm" className="mt-3">
                          <Plus className="mr-2 h-4 w-4" />
                          Add Talent
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
                  {filteredTalent.map((talent) => (
                    <TalentPickerCard
                      key={talent.id}
                      talent={talent}
                      isSelected={selectedTalentIds.includes(talent.id)}
                      onClick={() => toggleTalent(talent.id)}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Footer */}
            <div className="flex justify-between">
              <AddTalentDialog
                onCreated={handleTalentCreated}
                trigger={
                  <Button variant="outline" size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Talent
                  </Button>
                }
              />
              <div className="flex flex-col items-center gap-1">
                <Button type="submit">
                  {selectedTalentIds.length > 0
                    ? `Cast ${selectedTalentIds.length} role${selectedTalentIds.length === 1 ? '' : 's'}`
                    : 'Continue'}
                </Button>
                <span
                  className={cn(
                    'text-[10px] text-muted-foreground',
                    selectedTalentIds.length > 0 && 'invisible'
                  )}
                >
                  without casting
                </span>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
