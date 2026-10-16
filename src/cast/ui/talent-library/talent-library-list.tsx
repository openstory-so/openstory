import { TalentLibraryCard } from './talent-library-card';
import { Button } from '@/ui/shadcn/button';
import { Card } from '@/ui/shadcn/card';
import { useTalentSheetsRealtime } from '@/cast/ui/use-talent-sheets-realtime';
import type { TalentWithSheets } from '@/platform/server/db/schema';
import { sheetProgressCopy } from '@/cast/sheet-progress-copy';
import type React from 'react';

type TalentLibraryListProps = {
  talent?: TalentWithSheets[];
  isLoading?: boolean;
  error?: Error | null;
};

/** The library grid: talent and team characters lay out the same. */
export const LIBRARY_GRID_CLASS =
  'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4';

export const LibraryGridSkeleton: React.FC = () => (
  <div className={LIBRARY_GRID_CLASS}>
    {[1, 2, 3, 4, 5, 6].map((n) => (
      <Card key={`skeleton-${n}`} className="overflow-hidden animate-pulse">
        <div className="aspect-square bg-muted" />
        <div className="p-4">
          <div className="h-4 bg-muted rounded w-3/4 mb-2" />
          <div className="h-3 bg-muted rounded w-1/2" />
        </div>
      </Card>
    ))}
  </div>
);

export const TalentLibraryList: React.FC<TalentLibraryListProps> = ({
  talent,
  isLoading,
  error,
}) => {
  // Subscribe to realtime events for all talent
  const talentIds = talent?.map((t) => t.id) ?? [];
  const { isGenerating, generatingActivity } =
    useTalentSheetsRealtime(talentIds);

  if (isLoading) {
    return <LibraryGridSkeleton />;
  }

  if (error) {
    return (
      <Card className="p-8 text-center">
        <p className="text-destructive mb-4">Failed to load talent</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Try Again
        </Button>
      </Card>
    );
  }

  if (!talent || talent.length === 0) {
    return null;
  }

  return (
    <div className={LIBRARY_GRID_CLASS}>
      {talent.map((t) => (
        <TalentLibraryCard
          key={t.id}
          talent={t}
          isGenerating={isGenerating(t.id) && !t.referenceSheet}
          generatingLabel={sheetProgressCopy(
            generatingActivity(t.id) ?? 'sheet'
          )}
        />
      ))}
    </div>
  );
};
