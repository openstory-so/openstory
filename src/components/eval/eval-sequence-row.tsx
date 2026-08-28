import { useMemo } from 'react';
import type React from 'react';
import { AppImage } from '@/components/ui/app-image';
import { EvalSequenceMetadata } from './eval-sequence-metadata';
import { EvalSceneCell } from './eval-scene-cell';
import type { DialogTab } from './eval-cell-dialog';
import { useScenesBySequence, type SceneWithScript } from '@/hooks/use-scenes';
import type { SequenceWithShots } from '@/hooks/use-sequences-with-shots';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { ViewMode } from './eval-view';

const METADATA_WIDTH = 280;
const VIDEO_WIDTH = 400;
const CELL_WIDTH = 200;

type OpenDialogState = {
  sequenceIndex: number;
  sceneIndex: number;
  initialTab?: DialogTab;
} | null;

type EvalSequenceRowProps = {
  sequence: SequenceWithShots;
  viewMode: ViewMode;
  maxSceneCount: number;
  sequenceIndex: number;
  shotsLoading: boolean;
  divergence?: { hasMusic: boolean };
  openDialog: OpenDialogState;
  onOpenDialogChange: (state: OpenDialogState) => void;
  onNavigateToCell: (sequenceIndex: number, sceneIndex: number) => void;
  onOpenTheatre: (sequenceIndex: number) => void;
};

export const EvalSequenceRow: React.FC<EvalSequenceRowProps> = ({
  sequence,
  viewMode,
  maxSceneCount,
  sequenceIndex,
  shotsLoading,
  divergence,
  openDialog,
  onOpenDialogChange,
  onNavigateToCell,
  onOpenTheatre,
}) => {
  const aspectRatio: AspectRatio = sequence.aspectRatio ?? DEFAULT_ASPECT_RATIO;

  const { data: scenes } = useScenesBySequence(sequence.id);
  const scenesById = useMemo(() => {
    const map = new Map<string, SceneWithScript>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);

  const previewUrl = sequence.shots[0]?.image?.url ?? sequence.posterUrl;

  return (
    <>
      <div
        className="sticky left-0 z-10 bg-background shrink-0 h-full"
        style={{ width: METADATA_WIDTH }}
      >
        <EvalSequenceMetadata sequence={sequence} divergence={divergence} />
      </div>
      <div
        className="sticky z-10 bg-background shrink-0 h-full border-r border-b p-2 flex items-center justify-center"
        style={{ left: METADATA_WIDTH, width: VIDEO_WIDTH }}
      >
        {previewUrl ? (
          <button
            type="button"
            onClick={() => onOpenTheatre(sequenceIndex)}
            aria-label={`Play ${sequence.title || 'sequence'} in theatre`}
            className="w-full h-full flex items-center justify-center cursor-pointer appearance-none bg-transparent border-0 p-0"
          >
            <AppImage
              src={previewUrl}
              alt={`${sequence.title || 'Sequence'} preview`}
              className="max-w-full max-h-full object-contain rounded-md"
              loading="lazy"
              width={400}
              height={400}
            />
          </button>
        ) : (
          <div className="text-xs text-muted-foreground text-center">
            No preview
          </div>
        )}
      </div>
      {Array.from({ length: maxSceneCount }, (_, i) => {
        const shot = sequence.shots[i];
        const sceneIndex = i;
        const isDialogOpen =
          openDialog?.sequenceIndex === sequenceIndex &&
          openDialog.sceneIndex === sceneIndex;
        const dialogInitialTab = isDialogOpen
          ? openDialog.initialTab
          : undefined;

        return (
          <div
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- shot is undefined when sequence has fewer shots than maxSceneCount
            key={shot?.id ?? `empty-${i}`}
            className="shrink-0 h-full"
            style={{ width: CELL_WIDTH }}
          >
            <EvalSceneCell
              shot={shot}
              scene={shot?.sceneId ? scenesById.get(shot.sceneId) : undefined}
              viewMode={viewMode}
              sceneNumber={i + 1}
              sequenceTitle={sequence.title}
              aspectRatio={aspectRatio}
              shotsLoading={shotsLoading}
              dialogOpen={isDialogOpen}
              dialogInitialTab={dialogInitialTab}
              onDialogOpenChange={(open) => {
                if (open) {
                  onOpenDialogChange({ sequenceIndex, sceneIndex });
                } else {
                  onOpenDialogChange(null);
                }
              }}
              onNavigateLeft={() => {
                if (sceneIndex > 0) {
                  onNavigateToCell(sequenceIndex, sceneIndex - 1);
                }
              }}
              onNavigateRight={() => {
                if (sceneIndex < maxSceneCount - 1) {
                  onNavigateToCell(sequenceIndex, sceneIndex + 1);
                }
              }}
              onNavigateUp={() => {
                if (sequenceIndex > 0) {
                  onNavigateToCell(sequenceIndex - 1, sceneIndex);
                }
              }}
              onNavigateDown={() => {
                onNavigateToCell(sequenceIndex + 1, sceneIndex);
              }}
            />
          </div>
        );
      })}
    </>
  );
};
