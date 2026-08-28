import { TalentLibraryCard } from '@/components/talent-library/talent-library-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useTalentSheetsRealtime } from '@/hooks/use-talent-sheets-realtime';
import { useTeamTalentDivergentVariants } from '@/hooks/use-talent-sheet-variants';
import type { TalentWithSheets } from '@/lib/db/schema';
import { sheetProgressCopy } from '@/lib/talent/sheet-progress-copy';
import type React from 'react';
import { useMemo } from 'react';

type TalentLibraryListProps = {
  talent?: TalentWithSheets[];
  isLoading?: boolean;
  error?: Error | null;
};

export const TalentLibraryList: React.FC<TalentLibraryListProps> = ({
  talent,
  isLoading,
  error,
}) => {
  // Subscribe to realtime events for all talent
  const talentIds = talent?.map((t) => t.id) ?? [];
  const { isGenerating, generatingActivity } =
    useTalentSheetsRealtime(talentIds);

  // Collapse divergent variants to one dot per talent (oldest divergence wins).
  const { data: divergentVariants } = useTeamTalentDivergentVariants();
  const sheetIdToTalentId = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of talent ?? []) {
      for (const sheet of t.sheets) {
        map.set(sheet.id, t.id);
      }
    }
    return map;
  }, [talent]);
  const divergentByTalentId = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of divergentVariants ?? []) {
      const talentId = sheetIdToTalentId.get(v.talentSheetId);
      if (!talentId) continue;
      if (!map.has(talentId)) map.set(talentId, v.id);
    }
    return map;
  }, [divergentVariants, sheetIdToTalentId]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
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
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {talent.map((t) => (
        <TalentLibraryCard
          key={t.id}
          talent={t}
          isGenerating={isGenerating(t.id) && t.sheets.length === 0}
          generatingLabel={sheetProgressCopy(
            generatingActivity(t.id) ?? 'sheet'
          )}
          divergentVariantId={divergentByTalentId.get(t.id)}
        />
      ))}
    </div>
  );
};
