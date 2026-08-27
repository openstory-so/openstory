import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { adjacentShotId } from '@/lib/scenes/shot-walk';
import { cn } from '@/lib/utils';
import type { ShotView } from '@/lib/shots/shot-view';
import { ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SceneListItem } from './scene-list-item';
import { SceneThumbnail } from './scene-thumbnail';

type MobileSceneDrawerProps = {
  shots?: ShotView[];
  scenes?: SceneWithScript[];
  selectedShotId?: string;
  selectedSceneIds: readonly string[];
  aspectRatio: AspectRatio;
  onSelectShot: (shotId: string) => void;
  onFocusScene: (sceneId: string) => void;
  onClearSelection: () => void;
  onWalkShot: (delta: -1 | 1) => void;
};

type SceneGroup = {
  scene: SceneWithScript;
  shots: ShotView[];
};

export const MobileSceneDrawer: React.FC<MobileSceneDrawerProps> = ({
  shots,
  scenes,
  selectedShotId,
  selectedSceneIds,
  aspectRatio,
  onSelectShot,
  onFocusScene,
  onClearSelection,
  onWalkShot,
}) => {
  const [jumpOpen, setJumpOpen] = useState(false);
  const [drilledSceneId, setDrilledSceneId] = useState<string | null>(null);

  const scenesById = useMemo(() => {
    const map = new Map<string, SceneWithScript>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);

  const grouped = useMemo((): SceneGroup[] => {
    if (!scenes) return [];
    const byScene = new Map<string, ShotView[]>();
    for (const shot of shots ?? []) {
      if (!shot.sceneId) continue;
      const list = byScene.get(shot.sceneId) ?? [];
      list.push(shot);
      byScene.set(shot.sceneId, list);
    }
    return scenes.map((scene) => ({
      scene,
      shots: byScene.get(scene.id) ?? [],
    }));
  }, [scenes, shots]);

  const selectedShot = useMemo(
    () => shots?.find((s) => s.id === selectedShotId),
    [shots, selectedShotId]
  );

  const focusedSceneId =
    selectedShot?.sceneId ??
    (selectedSceneIds.length === 1 ? selectedSceneIds[0] : undefined);
  const focusedScene = focusedSceneId
    ? scenesById.get(focusedSceneId)
    : undefined;
  const sceneShots = useMemo(
    () =>
      focusedSceneId && shots
        ? shots.filter((s) => s.sceneId === focusedSceneId)
        : [],
    [focusedSceneId, shots]
  );

  const sceneNumber = (focusedScene?.orderIndex ?? 0) + 1;
  const sceneTitle = focusedScene?.title?.trim() || `Scene ${sceneNumber}`;
  const shotOrdinal = selectedShot
    ? sceneShots.findIndex((s) => s.id === selectedShot.id) + 1
    : 0;
  const isSequence = !selectedShotId && selectedSceneIds.length === 0;

  const label = isSequence
    ? 'All scenes'
    : sceneShots.length > 1 && shotOrdinal > 0
      ? `${sceneTitle} · Shot ${shotOrdinal} of ${sceneShots.length}`
      : sceneTitle;

  const previewShot =
    selectedShot ??
    sceneShots.find((s) => s.image?.url || s.previewThumbnailUrl) ??
    shots?.find((s) => s.image?.url || s.previewThumbnailUrl);

  const walkHit = (delta: -1 | 1) =>
    adjacentShotId(
      shots ?? [],
      {
        shotId: selectedShotId,
        sceneIds: selectedSceneIds,
      },
      delta
    );

  const canPrev = walkHit(-1) != null;
  const canNext = walkHit(1) != null;

  const walk = (delta: -1 | 1) => {
    if (walkHit(delta)) onWalkShot(delta);
  };

  const closeJump = () => {
    setJumpOpen(false);
    setDrilledSceneId(null);
  };

  const drilled = drilledSceneId
    ? grouped.find((g) => g.scene.id === drilledSceneId)
    : undefined;

  return (
    <>
      <div
        data-testid="mobile-scene-nav"
        className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-1 border-t bg-background px-1 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          disabled={!canPrev}
          aria-label="Previous shot"
          onClick={() => walk(-1)}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-haspopup="dialog"
          aria-expanded={jumpOpen}
          aria-label={`${label}. Open scene list`}
          onClick={() => setJumpOpen(true)}
        >
          <SceneThumbnail
            thumbnailUrl={previewShot?.image?.url}
            previewThumbnailUrl={previewShot?.previewThumbnailUrl}
            thumbnailStatus={previewShot?.frame.imageStatus || undefined}
            gridSheetUrl={previewShot?.gridSheet?.url}
            pendingUpscaleIndex={previewShot?.pendingUpscaleIndex}
            pendingUpscaleUrl={previewShot?.pendingUpscaleUrl}
            alt={isSequence ? 'Sequence' : sceneTitle}
            aspectRatio={aspectRatio}
            className="aspect-square h-10 w-10 shrink-0 rounded"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {label}
          </span>
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          disabled={!canNext}
          aria-label="Next shot"
          onClick={() => walk(1)}
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      <Sheet
        open={jumpOpen}
        onOpenChange={(open) => {
          setJumpOpen(open);
          if (!open) setDrilledSceneId(null);
        }}
      >
        <SheetContent
          side="bottom"
          className="flex max-h-[70dvh] min-h-0 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="shrink-0">
            {drilled ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11"
                  aria-label="Back to scenes"
                  onClick={() => setDrilledSceneId(null)}
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <SheetTitle className="min-w-0 truncate">
                  {drilled.scene.title?.trim() ||
                    `Scene ${drilled.scene.orderIndex + 1}`}
                </SheetTitle>
              </div>
            ) : (
              <SheetTitle>
                {grouped.length} {grouped.length === 1 ? 'Scene' : 'Scenes'}
              </SheetTitle>
            )}
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
            {drilled ? (
              <div className="flex flex-col gap-3 py-2">
                {drilled.shots.map((shot) => (
                  <SceneListItem
                    key={shot.id}
                    shot={shot}
                    scene={drilled.scene}
                    aspectRatio={aspectRatio}
                    isActive={shot.id === selectedShotId}
                    variant="horizontal"
                    onSelect={() => {
                      onSelectShot(shot.id);
                      closeJump();
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2 py-2">
                <button
                  type="button"
                  className={cn(
                    'rounded-lg border px-3 py-3 text-left text-sm',
                    isSequence
                      ? 'border-primary bg-primary/5 font-medium'
                      : 'hover:bg-muted/40'
                  )}
                  onClick={() => {
                    onClearSelection();
                    closeJump();
                  }}
                >
                  Whole sequence
                </button>
                {grouped.map(({ scene, shots: sceneShots }) => {
                  const title =
                    scene.title?.trim() || `Scene ${scene.orderIndex + 1}`;
                  const still =
                    sceneShots.find(
                      (s) => s.image?.url || s.previewThumbnailUrl
                    ) ?? sceneShots[0];
                  const active =
                    focusedSceneId === scene.id ||
                    selectedSceneIds.includes(scene.id);
                  const multi = sceneShots.length > 1;
                  return (
                    <button
                      key={scene.id}
                      type="button"
                      className={cn(
                        'flex items-center gap-3 rounded-lg border px-3 py-2 text-left',
                        active
                          ? 'border-primary bg-primary/5'
                          : 'hover:bg-muted/40'
                      )}
                      onClick={() => {
                        if (multi) {
                          onFocusScene(scene.id);
                          setDrilledSceneId(scene.id);
                          return;
                        }
                        const only = sceneShots[0];
                        if (only) onSelectShot(only.id);
                        else onFocusScene(scene.id);
                        closeJump();
                      }}
                    >
                      <SceneThumbnail
                        thumbnailUrl={still?.image?.url}
                        previewThumbnailUrl={still?.previewThumbnailUrl}
                        thumbnailStatus={still?.frame.imageStatus || undefined}
                        alt={title}
                        aspectRatio={aspectRatio}
                        className="aspect-square h-12 w-12 shrink-0 rounded"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {title}
                        </span>
                        {multi && (
                          <span className="block text-xs text-muted-foreground">
                            {sceneShots.length} shots
                          </span>
                        )}
                      </span>
                      {multi && (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};
