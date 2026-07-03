import {
  BatchMotionFooter,
  type BatchGenerateMotionArgs,
} from '@/components/scenes/batch-motion-footer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { type AudioModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ShotVariant } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { memo, useMemo } from 'react';
import { SceneListItem } from './scene-list-item';

export type { BatchGenerateMotionArgs };

type SceneListProps = {
  shots?: ShotWithImage[] | undefined;
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  onSelectShot: (shotId: string) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Live divergent alternates for the current sequence (filtered per-shot). */
  divergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
  /**
   * Scenes the pinned image model hasn't generated yet (#547). Those cards show
   * a "No {model}" badge so the thumbnail (which still shows the primary image)
   * isn't mistaken for the pinned model's output.
   */
  modelMissingShotIds?: Set<string>;
  /** Name of the pinned image model, for the per-card "No {model}" badge. */
  modelMissingLabel?: string | null;
};

const SceneListComponent: React.FC<SceneListProps> = ({
  shots,
  selectedShotId,
  aspectRatio,
  onSelectShot,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  divergentVariants,
  onCompareDivergent,
  initialMusicModel,
  modelMissingShotIds,
  modelMissingLabel,
}) => {
  const divergentByShotId = useMemo(() => {
    const map = new Map<string, ShotVariant>();
    for (const v of divergentVariants ?? []) {
      // Image variant is what surfaces on the card. Other variant types
      // live on their respective tabs per the spec's surfacing matrix.
      if (v.variantType !== 'image') continue;
      if (!map.has(v.shotId)) map.set(v.shotId, v);
    }
    return map;
  }, [divergentVariants]);

  const renderShotCard = (shot: ShotWithImage) => {
    const divergent = divergentByShotId.get(shot.id);
    return (
      <SceneListItem
        key={shot.id}
        shot={shot}
        aspectRatio={aspectRatio}
        isActive={shot.id === selectedShotId}
        onSelect={() => onSelectShot(shot.id)}
        isRegeneratingImage={regeneratingImages.has(shot.id)}
        isRegeneratingMotion={regeneratingMotion.has(shot.id)}
        divergentVariantId={divergent?.id}
        onCompareDivergent={
          divergent ? () => onCompareDivergent?.(divergent) : undefined
        }
        modelMissing={
          !!modelMissingLabel && (modelMissingShotIds?.has(shot.id) ?? false)
        }
        modelMissingLabel={modelMissingLabel}
      />
    );
  };

  return (
    <div className="flex h-full w-[280px] lg:w-[480px] flex-col rounded-lg border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Scenes
        </h2>
      </div>

      {/* Scene list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-3 p-4">
          {(shots === undefined || shots.length === 0) &&
            [1, 2, 3].map((i) => (
              <SceneListItem
                key={`shot-skeleton-${i}`}
                shot={undefined}
                aspectRatio={aspectRatio}
                isActive={false}
              />
            ))}

          {shots && shots.map(renderShotCard)}
        </div>
      </ScrollArea>

      <BatchMotionFooter
        shots={shots}
        regeneratingMotion={regeneratingMotion}
        onBatchGenerateMotion={onBatchGenerateMotion}
        musicPromptsReady={musicPromptsReady}
        hideBatchButton={hideBatchButton}
        initialMusicModel={initialMusicModel}
      />
    </div>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling.
// Relies on TanStack Query's structural sharing to preserve object references.
const areEqual = (
  prevProps: SceneListProps,
  nextProps: SceneListProps
): boolean => {
  if (
    prevProps.selectedShotId !== nextProps.selectedShotId ||
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady ||
    prevProps.initialMusicModel !== nextProps.initialMusicModel ||
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel ||
    prevProps.modelMissingShotIds !== nextProps.modelMissingShotIds
  ) {
    return false;
  }

  if (
    prevProps.regeneratingImages !== nextProps.regeneratingImages ||
    prevProps.regeneratingMotion !== nextProps.regeneratingMotion
  ) {
    return false;
  }

  if (
    prevProps.onBatchGenerateMotion !== nextProps.onBatchGenerateMotion ||
    prevProps.onCompareDivergent !== nextProps.onCompareDivergent
  ) {
    return false;
  }

  if (prevProps.divergentVariants !== nextProps.divergentVariants) {
    return false;
  }

  // TanStack Query's structural sharing keeps the array reference stable when
  // the contents are unchanged, so reference equality is sufficient.
  if (prevProps.shots === nextProps.shots) {
    return true;
  }
  if (!prevProps.shots || !nextProps.shots) {
    return false;
  }
  if (prevProps.shots.length !== nextProps.shots.length) {
    return false;
  }
  for (let i = 0; i < prevProps.shots.length; i++) {
    if (prevProps.shots[i] !== nextProps.shots[i]) {
      return false;
    }
  }

  return true;
};

export const SceneList = memo(SceneListComponent, areEqual);
