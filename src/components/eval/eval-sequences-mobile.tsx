import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AppImage } from '@/components/ui/app-image';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EvalSceneCell } from './eval-scene-cell';
import type { DialogTab } from './eval-cell-dialog';
import { useScenesBySequence, type SceneWithScript } from '@/hooks/use-scenes';
import type { SequenceWithShots } from '@/hooks/use-sequences-with-shots';
import type { ViewMode } from './eval-view';
import { getAspectRatioData } from '@/lib/constants/aspect-ratios';
import { getAnalysisModelById } from '@/lib/ai/models.config';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Mail, User } from 'lucide-react';
import { SequenceListStatus } from './eval-sequence-metadata';
import { getCreatorIdentity } from './creator-identity';

// Strip cell height in px. Widths follow each sequence's aspect ratio so the
// strip stays visually coherent inside one row.
const STRIP_HEIGHT = 180;

// Virtualized-row size estimate: strip (180) + title/creator block + paddings.
// `measureElement` corrects each row's real height once mounted, so this only
// needs to be in the right ballpark to seed the initial scroll window.
const ESTIMATED_ROW_HEIGHT = 248;

type OpenDialogState = {
  sequenceIndex: number;
  sceneIndex: number;
  initialTab?: DialogTab;
} | null;

type EvalSequencesMobileProps = {
  sequences: SequenceWithShots[];
  viewMode: ViewMode;
  shotsLoadingMap: Record<string, boolean>;
  divergenceMap?: Map<string, { hasMusic: boolean }>;
  onLoadMore?: () => void;
  hasMore?: boolean;
};

export const EvalSequencesMobile: React.FC<EvalSequencesMobileProps> = ({
  sequences,
  viewMode,
  shotsLoadingMap,
  divergenceMap,
  onLoadMore,
  hasMore,
}) => {
  const [openDialog, setOpenDialog] = useState<OpenDialogState>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const maxSceneCount = useMemo(
    () => Math.max(1, ...sequences.map((s) => s.shots.length)),
    [sequences]
  );

  const handleNavigateToCell = (sequenceIndex: number, sceneIndex: number) => {
    if (
      sequenceIndex >= 0 &&
      sequenceIndex < sequences.length &&
      sceneIndex >= 0 &&
      sceneIndex < maxSceneCount
    ) {
      setOpenDialog({ sequenceIndex, sceneIndex });
    }
  };

  // Mirror EvalMatrix's row virtualization (#748). The mobile reel view used to
  // mount every sequence row — and every shot strip within each row — in one
  // synchronous pass. On a large team that N×M mount is what pushed iOS WebKit
  // past its per-tab memory budget and killed the WebProcess ("Can't open this
  // page"). Render only the visible rows (+overscan); row height is measured
  // because the title/creator block varies.
  const rowVirtualizer = useVirtualizer({
    count: sequences.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 5,
  });

  // Infinite scroll: fetch the next page as the last rows come into view, the
  // same trigger EvalMatrix uses so support mode pages in identically. Replaces
  // the old manual "Load more" button (regular users have hasMore=false, so the
  // visible behavior only changes in support mode).
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastItemIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- lastItemIndex is undefined until rows are virtualized
    if (lastItemIndex == null || lastItemIndex >= sequences.length - 5) {
      onLoadMore();
    }
  }, [lastItemIndex, sequences.length, onLoadMore, hasMore]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const sequence = sequences[virtualRow.index];
          if (!sequence) return null;
          return (
            <div
              key={sequence.id}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="absolute left-0 right-0 top-0 border-b border-border"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MobileReelRow
                sequence={sequence}
                sequenceIndex={virtualRow.index}
                sequenceCount={sequences.length}
                viewMode={viewMode}
                shotsLoading={shotsLoadingMap[sequence.id] ?? false}
                divergence={divergenceMap?.get(sequence.id)}
                openDialog={openDialog}
                onOpenDialogChange={setOpenDialog}
                onNavigateToCell={handleNavigateToCell}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

type MobileReelRowProps = {
  sequence: SequenceWithShots;
  sequenceIndex: number;
  sequenceCount: number;
  viewMode: ViewMode;
  shotsLoading: boolean;
  divergence?: { hasMusic: boolean };
  openDialog: OpenDialogState;
  onOpenDialogChange: (state: OpenDialogState) => void;
  onNavigateToCell: (sequenceIndex: number, sceneIndex: number) => void;
};

const MobileReelRow: React.FC<MobileReelRowProps> = ({
  sequence,
  sequenceIndex,
  sequenceCount,
  viewMode,
  shotsLoading,
  divergence,
  openDialog,
  onOpenDialogChange,
  onNavigateToCell,
}) => {
  const aspectRatio = sequence.aspectRatio;
  const { data: scenes } = useScenesBySequence(sequence.id);
  const scenesById = useMemo(() => {
    const map = new Map<string, SceneWithScript>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);
  const ratioData = getAspectRatioData(aspectRatio);
  const cellWidth = ratioData
    ? (STRIP_HEIGHT * ratioData.width) / ratioData.height
    : STRIP_HEIGHT;
  const shotCount = sequence.shots.length;
  const hasVariants = Boolean(divergence?.hasMusic);

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to="/sequences/$id/scenes"
            params={{ id: sequence.id }}
            className="font-medium text-sm text-foreground line-clamp-1 hover:underline"
            title={sequence.title || 'Untitled Sequence'}
          >
            {sequence.title || 'Untitled Sequence'}
          </Link>
          <CreatorIdentity sequence={sequence} />
          <SequenceListStatus sequence={sequence} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {hasVariants && (
            <span
              aria-label="Variants available — open to compare"
              title="Variants available — open to compare"
              className="inline-flex h-2 w-2 rounded-full bg-sky-500 ring-2 ring-sky-500/30"
            />
          )}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Open sequence"
          >
            <Link to="/sequences/$id/scenes" params={{ id: sequence.id }}>
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="-mx-3 overflow-x-auto [mask-image:linear-gradient(to_right,black,black_calc(100%-12px),transparent)]">
        <div
          className="flex gap-2 pl-3"
          style={{ height: STRIP_HEIGHT, minWidth: 'min-content' }}
        >
          <SequencePosterCell
            sequence={sequence}
            width={cellWidth}
            height={STRIP_HEIGHT}
          />
          {shotCount === 0 ? (
            shotsLoading ? (
              <Skeleton
                style={{ width: cellWidth, height: STRIP_HEIGHT }}
                className="shrink-0"
              />
            ) : (
              <div
                className="shrink-0 border-2 border-dashed border-muted rounded-md flex items-center justify-center text-xs text-muted-foreground"
                style={{ width: cellWidth, height: STRIP_HEIGHT }}
              >
                No scenes yet
              </div>
            )
          ) : (
            sequence.shots.map((shot, sceneIndex) => {
              const isDialogOpen =
                openDialog?.sequenceIndex === sequenceIndex &&
                openDialog.sceneIndex === sceneIndex;
              const dialogInitialTab = isDialogOpen
                ? openDialog.initialTab
                : undefined;

              return (
                <div
                  key={shot.id}
                  className="shrink-0 border rounded-md overflow-hidden bg-card [&>button]:!border-b-0 [&>div]:!border-b-0"
                  style={{ width: cellWidth, height: STRIP_HEIGHT }}
                >
                  <EvalSceneCell
                    shot={shot}
                    scene={
                      shot.sceneId ? scenesById.get(shot.sceneId) : undefined
                    }
                    viewMode={viewMode}
                    sceneNumber={sceneIndex + 1}
                    sequenceTitle={sequence.title}
                    aspectRatio={aspectRatio}
                    shotsLoading={shotsLoading}
                    dialogOpen={isDialogOpen}
                    dialogInitialTab={dialogInitialTab}
                    onDialogOpenChange={(open) => {
                      onOpenDialogChange(
                        open ? { sequenceIndex, sceneIndex } : null
                      );
                    }}
                    onNavigateLeft={() => {
                      if (sceneIndex > 0) {
                        onNavigateToCell(sequenceIndex, sceneIndex - 1);
                      }
                    }}
                    onNavigateRight={() => {
                      if (sceneIndex < shotCount - 1) {
                        onNavigateToCell(sequenceIndex, sceneIndex + 1);
                      }
                    }}
                    onNavigateUp={() => {
                      if (sequenceIndex > 0) {
                        onNavigateToCell(sequenceIndex - 1, sceneIndex);
                      }
                    }}
                    onNavigateDown={() => {
                      if (sequenceIndex < sequenceCount - 1) {
                        onNavigateToCell(sequenceIndex + 1, sceneIndex);
                      }
                    }}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

const CreatorIdentity: React.FC<{ sequence: SequenceWithShots }> = ({
  sequence,
}) => {
  const { name, email } = getCreatorIdentity(sequence);
  if (!name && !email) return null;

  return (
    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
      {name ? (
        <User className="h-3 w-3 shrink-0" />
      ) : (
        <Mail className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{name ?? email}</span>
    </div>
  );
};

type SequencePosterCellProps = {
  sequence: SequenceWithShots;
  width: number;
  height: number;
};

const SequencePosterCell: React.FC<SequencePosterCellProps> = ({
  sequence,
  width,
  height,
}) => {
  const baseClass =
    'shrink-0 border rounded-md overflow-hidden bg-card relative flex items-center justify-center';
  const style = { width, height };

  const analysisModelName =
    getAnalysisModelById(sequence.analysisModel)?.name ??
    sequence.analysisModel;

  const modelBadge = (
    <span className="absolute top-1 right-1 z-[1] inline-flex items-center text-[10px] leading-none text-foreground/90 bg-background/80 backdrop-blur-sm px-1.5 py-0.5 rounded-sm border border-border/40 pointer-events-none max-w-[calc(100%-0.5rem)] truncate">
      {analysisModelName}
    </span>
  );

  const linkProps = {
    to: '/sequences/$id/scenes',
    params: { id: sequence.id },
    'aria-label': `Open ${sequence.title || 'sequence'}`,
  } as const;

  const previewUrl = sequence.shots[0]?.image?.url ?? sequence.posterUrl;

  if (previewUrl) {
    return (
      <Link {...linkProps} className={baseClass} style={style}>
        <AppImage
          src={previewUrl}
          alt={`${sequence.title || 'Sequence'} poster`}
          className="w-full h-full object-cover"
          loading="lazy"
          width={400}
          height={400}
        />
        {modelBadge}
      </Link>
    );
  }

  return (
    <Link
      {...linkProps}
      className={`${baseClass} border-dashed text-xs text-muted-foreground`}
      style={style}
    >
      No preview yet
      {modelBadge}
    </Link>
  );
};
