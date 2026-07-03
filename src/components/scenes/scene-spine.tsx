/**
 * Spine (#986) — the left rail of the unified Scenes editor.
 *
 * Shots grouped under their scene headers; selection is the scope control:
 * click a scene header = scene scope, click a shot = shot scope,
 * cmd/ctrl-click = toggle a scene into the multi-selection, shift-click =
 * contiguous scene range. The header row ("Scenes") toggles all scenes
 * selected ↔ none. During playback clicking any shot jumps the playhead
 * there (wired by the parent); the playhead itself is only marked in the
 * player's filmstrip.
 */

import {
  BatchMotionFooter,
  type BatchGenerateMotionArgs,
} from '@/components/scenes/batch-motion-footer';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type AudioModel,
} from '@/lib/ai/models';
import {
  resolveSceneImageModel,
  resolveSceneVideoModel,
} from '@/lib/ai/resolve-scene-models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { SceneRow, ShotVariant } from '@/lib/db/schema';
import {
  rangeSelectScenes,
  selectScene,
  selectShot,
  toggleAllScenes,
  toggleScene,
  type SceneSelection,
} from '@/lib/scenes/selection';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { cn } from '@/lib/utils';
import type { Sequence } from '@/types/database';
import { memo, useMemo } from 'react';
import { SceneListItem } from './scene-list-item';

type SceneSpineProps = {
  shots?: ShotWithImage[] | undefined;
  scenes?: SceneRow[] | undefined;
  sequence?: Sequence | undefined;
  aspectRatio: AspectRatio;
  selection: SceneSelection;
  onSelectionChange: (next: SceneSelection) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  hideBatchButton?: boolean;
  divergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  initialMusicModel?: AudioModel;
  modelMissingShotIds?: Set<string>;
  modelMissingLabel?: string | null;
};

type SceneGroup = {
  sceneId: string | null;
  scene?: SceneRow;
  shots: ShotWithImage[];
};

function modelName(kind: 'image' | 'video', model: string): string {
  if (kind === 'image') {
    return isValidTextToImageModel(model) ? IMAGE_MODELS[model].name : model;
  }
  return isValidImageToVideoModel(model)
    ? IMAGE_TO_VIDEO_MODELS[model].name
    : model;
}

const SceneSpineComponent: React.FC<SceneSpineProps> = ({
  shots,
  scenes,
  sequence,
  aspectRatio,
  selection,
  onSelectionChange,
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
      if (v.variantType !== 'image') continue;
      if (!map.has(v.shotId)) map.set(v.shotId, v);
    }
    return map;
  }, [divergentVariants]);

  const scenesById = useMemo(() => {
    const map = new Map<string, SceneRow>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);

  // Group ordered shots under their scene, preserving playback order. Shots
  // with no sceneId (legacy) get a headerless trailing group.
  const groups = useMemo<SceneGroup[]>(() => {
    if (!shots) return [];
    const ordered = [...shots].sort((a, b) => a.orderIndex - b.orderIndex);
    const result: SceneGroup[] = [];
    const byScene = new Map<string, SceneGroup>();
    for (const shot of ordered) {
      const key = shot.sceneId ?? null;
      if (key === null) {
        const last = result[result.length - 1];
        if (last && last.sceneId === null) last.shots.push(shot);
        else result.push({ sceneId: null, shots: [shot] });
        continue;
      }
      const existing = byScene.get(key);
      if (existing) {
        existing.shots.push(shot);
      } else {
        const group: SceneGroup = {
          sceneId: key,
          scene: scenesById.get(key),
          shots: [shot],
        };
        byScene.set(key, group);
        result.push(group);
      }
    }
    return result;
  }, [shots, scenesById]);

  const selectedScenes = useMemo(
    () => new Set(selection.sceneIds),
    [selection.sceneIds]
  );

  const handleSceneClick = (sceneId: string, e: React.MouseEvent) => {
    if (!shots) return;
    if (e.metaKey || e.ctrlKey) {
      onSelectionChange(toggleScene(selection, sceneId));
    } else if (e.shiftKey) {
      onSelectionChange(rangeSelectScenes(selection, sceneId, shots));
    } else {
      onSelectionChange(selectScene(sceneId));
    }
  };

  const sequenceModels = {
    imageModel: sequence?.imageModel,
    videoModel: sequence?.videoModel,
  };

  const renderShotCard = (shot: ShotWithImage) => {
    const divergent = divergentByShotId.get(shot.id);
    return (
      <SceneListItem
        key={shot.id}
        shot={shot}
        aspectRatio={aspectRatio}
        isActive={shot.id === selection.shotId}
        onSelect={() => onSelectionChange(selectShot(shot.id))}
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
    <div className="flex h-full w-[280px] xl:w-[320px] flex-col rounded-lg border bg-background">
      {/* Header — clicking it toggles all scenes selected ↔ none (Esc always
          clears back to whole-sequence scope). */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 px-2 text-sm font-semibold uppercase tracking-wide',
            selection.sceneIds.length === 0 && !selection.shotId
              ? 'text-foreground'
              : 'text-muted-foreground'
          )}
          onClick={() =>
            onSelectionChange(toggleAllScenes(selection, shots ?? []))
          }
          title="Select all scenes · click again to clear (Esc)"
        >
          Scenes
        </Button>
        {shots && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {shots.length} {shots.length === 1 ? 'shot' : 'shots'}
          </span>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-2 p-3">
          {(shots === undefined || shots.length === 0) &&
            [1, 2, 3].map((i) => (
              <SceneListItem
                key={`shot-skeleton-${i}`}
                shot={undefined}
                aspectRatio={aspectRatio}
                isActive={false}
              />
            ))}

          {groups.map((group, groupIndex) => {
            const groupSceneId = group.sceneId;
            const isSelected =
              groupSceneId !== null && selectedScenes.has(groupSceneId);
            const title =
              group.scene?.title ??
              group.shots[0]?.metadata?.metadata?.title ??
              `Scene ${groupIndex + 1}`;
            const lookModel = resolveSceneImageModel(
              group.scene,
              sequenceModels
            );
            const motionModel = resolveSceneVideoModel(
              group.scene,
              sequenceModels
            );
            return (
              <div
                key={groupSceneId ?? `ungrouped-${groupIndex}`}
                className="flex flex-col gap-2"
              >
                {groupSceneId !== null && (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={(e) => handleSceneClick(groupSceneId, e)}
                    className={cn(
                      'flex w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors',
                      isSelected
                        ? 'border-primary bg-primary/10'
                        : 'border-transparent bg-muted/40 hover:bg-muted'
                    )}
                    title="Click to scope to this scene · ⌘-click to multi-select · ⇧-click for a range"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {title}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {group.shots.length}{' '}
                        {group.shots.length === 1 ? 'shot' : 'shots'}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {modelName('image', lookModel)} ·{' '}
                      {modelName('video', motionModel)}
                    </span>
                  </button>
                )}
                <div
                  className={cn(
                    'flex flex-col gap-2',
                    groupSceneId !== null && 'pl-2 border-l-2',
                    isSelected ? 'border-primary' : 'border-border'
                  )}
                >
                  {group.shots.map(renderShotCard)}
                </div>
              </div>
            );
          })}
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

export const SceneSpine = memo(SceneSpineComponent);
