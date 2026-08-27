import { Badge } from '@/components/ui/badge';
import { videoModelDisplayName } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { ShotVariant } from '@/lib/db/schema';
import {
  groupShotsBySegment,
  type SequenceSegment,
} from '@/lib/scenes/scene-segments';
import type { ShotView } from '@/lib/shots/shot-view';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Film } from 'lucide-react';
import { Fragment, memo, useMemo, useState } from 'react';
import { SceneListItem } from './scene-list-item';

type SceneGroupProps = {
  scene: SceneWithScript;
  shots: ShotView[];
  /** Render segments by id (#986) — bracket the shots that share one video. */
  segmentsById: ReadonlyMap<string, SequenceSegment>;
  isSceneSelected: boolean;
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  onSelectScene: (sceneId: string, additive: boolean) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  divergentByShotId: Map<string, ShotVariant>;
  onCompareDivergent?: (variant: ShotVariant) => void;
  modelMissingShotIds?: Set<string>;
  modelMissingLabel?: string | null;
  /** Shots with stale prompts/image (#1077) — amber corner dot. */
  staleShotIds?: Set<string>;
};

const SceneGroupComponent: React.FC<SceneGroupProps> = ({
  scene,
  shots,
  segmentsById,
  isSceneSelected,
  selectedShotId,
  aspectRatio,
  onSelectScene,
  regeneratingImages,
  regeneratingMotion,
  divergentByShotId,
  onCompareDivergent,
  modelMissingShotIds,
  modelMissingLabel,
  staleShotIds,
}) => {
  const [expanded, setExpanded] = useState(true);

  // Group the scene's shots into their render segments; every rendered segment
  // is bracketed as its own video (the video model lives on the segment, not the
  // scene), so the model shows here — even for a single shot (#986).
  const shotGroups = useMemo(
    () => groupShotsBySegment(shots, segmentsById),
    [shots, segmentsById]
  );

  const sceneLabel = useMemo(() => {
    const index = scene.orderIndex + 1;
    return scene.title?.trim() || `Scene ${index}`;
  }, [scene.orderIndex, scene.title]);

  const handleSceneClick = (e: React.MouseEvent) => {
    onSelectScene(scene.id, e.metaKey || e.ctrlKey);
  };

  return (
    <div
      data-testid="scene-group"
      data-scene-id={scene.id}
      className={cn(
        'rounded-lg border transition-colors',
        isSceneSelected && !selectedShotId
          ? 'border-primary bg-primary/5'
          : 'border-border/60'
      )}
    >
      <div className="flex w-full items-start gap-2 px-3 py-2.5 hover:bg-muted/40">
        <button
          type="button"
          className="mt-0.5 shrink-0 text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse scene' : 'Expand scene'}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 space-y-1.5 text-left"
          onClick={handleSceneClick}
          aria-label={sceneLabel}
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{sceneLabel}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {shots.length} {shots.length === 1 ? 'shot' : 'shots'}
            </span>
          </div>
        </button>
      </div>

      {expanded && shots.length > 0 && (
        <div className="flex flex-col gap-2 border-t px-3 py-2">
          {shotGroups.map((group) => {
            const items = group.shots.map((shot) => {
              const divergent = divergentByShotId.get(shot.id);
              return (
                <SceneListItem
                  key={shot.id}
                  shot={shot}
                  scene={scene}
                  aspectRatio={aspectRatio}
                  isActive={shot.id === selectedShotId}
                  variant="horizontal"
                  isRegeneratingImage={regeneratingImages.has(shot.id)}
                  isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                  divergentVariantId={divergent?.id}
                  onCompareDivergent={
                    divergent
                      ? () => onCompareDivergent?.(divergent)
                      : undefined
                  }
                  modelMissing={
                    !!modelMissingLabel &&
                    (modelMissingShotIds?.has(shot.id) ?? false)
                  }
                  modelMissingLabel={modelMissingLabel}
                  isStale={staleShotIds?.has(shot.id) ?? false}
                />
              );
            });

            const key = group.segmentId ?? `unassigned-${group.shots[0]?.id}`;
            // No segment yet (shot never rendered) → render flat; there's no
            // video / model to label.
            if (!group.segment) {
              return <Fragment key={key}>{items}</Fragment>;
            }
            // Every rendered segment is bracketed as one video — even a single
            // shot — so its video model (a per-segment fact) always shows. The
            // shot count is only spelled out when a video spans more than one.
            const segment = group.segment;
            const modelName = segment.model
              ? videoModelDisplayName(segment.model)
              : null;
            return (
              <div
                key={key}
                className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 p-2"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Film className="h-3 w-3 shrink-0" />
                  <span className="truncate font-medium text-foreground">
                    {modelName ?? 'Video'}
                  </span>
                  {group.shots.length > 1 && (
                    <span className="shrink-0">{group.shots.length} shots</span>
                  )}
                  {segment.stale && (
                    <Badge
                      variant="outline"
                      className="ml-auto shrink-0 px-1 py-0 text-[10px]"
                    >
                      Stale
                    </Badge>
                  )}
                </div>
                {items}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const SceneGroup = memo(SceneGroupComponent);
