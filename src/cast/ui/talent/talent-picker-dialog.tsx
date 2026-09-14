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
import { useTalent } from '@/cast/ui/use-talent';
import type { TalentWithSheets } from '@/platform/server/db/schema';
import {
  talentSquareImageClassName,
  talentSquarePreview,
} from '@/cast/talent-preview';
import { cn } from '@/ui/utils';
import { Search, User } from 'lucide-react';
import { useState } from 'react';
import { AppImage } from '@/ui/shadcn/app-image';

type TalentPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (talent: TalentWithSheets) => void;
  excludeTalentId?: string;
};

type TalentPickerCardProps = {
  talent: TalentWithSheets;
  onClick: () => void;
};

const TalentPickerCard: React.FC<TalentPickerCardProps> = ({
  talent,
  onClick,
}) => {
  const preview = talentSquarePreview(talent);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
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
    </button>
  );
};

export const TalentPickerDialog: React.FC<TalentPickerDialogProps> = ({
  open,
  onOpenChange,
  onSelect,
  excludeTalentId,
}) => {
  const { data: talentList, isLoading } = useTalent();
  const [searchQuery, setSearchQuery] = useState('');

  // Filter talent by search query and exclude current
  const filteredTalent = talentList?.filter((t) => {
    if (excludeTalentId && t.id === excludeTalentId) return false;
    if (!searchQuery) return true;
    return t.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const handleSelect = (talent: TalentWithSheets) => {
    onSelect(talent);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select Talent</DialogTitle>
          <DialogDescription>
            Choose talent from your library to assign to this role.
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
                <div key={i} className="flex flex-col items-center gap-2 p-3">
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
                  : 'No talent in library'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
              {filteredTalent.map((talent) => (
                <TalentPickerCard
                  key={talent.id}
                  talent={talent}
                  onClick={() => handleSelect(talent)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
