import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  restoreScene,
  restoreShot,
  useCreateShot,
  useReorderShots,
  useSoftDeleteScene,
  useSoftDeleteShot,
  useUpdateScene,
} from '@/hooks/use-scene-structure';
import { videoModelDisplayName } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { ShotVariant } from '@/lib/db/schema';
import { errorMessage } from '@/lib/errors';
import {
  groupShotsBySegment,
  type SequenceSegment,
} from '@/lib/scenes/scene-segments';
import type { ShotView } from '@/lib/shots/shot-view';
import { cn } from '@/lib/utils';
import { plainSceneTitle } from '@/lib/utils/markdown-plain';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Film,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SceneListItem } from './scene-list-item';

type SceneGroupProps = {
  scene: SceneWithScript;
  shots: ShotView[];
  sequenceId: string;
  /** Render segments by id (#986) — bracket the shots that share one video. */
  segmentsById: ReadonlyMap<string, SequenceSegment>;
  isSceneSelected: boolean;
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  onSelectScene: (sceneId: string, additive: boolean) => void;
  onSelectShot: (shotId: string) => void;
  /** Deleting the selected scene/shot zooms selection back out (#1108). */
  onClearSelection: () => void;
  /** Scene position among live scenes — drives Move up/down availability. */
  isFirst: boolean;
  isLast: boolean;
  onMoveScene: (
    sceneId: SceneWithScript['id'],
    direction: 'up' | 'down'
  ) => void;
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
  sequenceId,
  segmentsById,
  isSceneSelected,
  selectedShotId,
  aspectRatio,
  onSelectScene,
  onSelectShot,
  onClearSelection,
  isFirst,
  isLast,
  onMoveScene,
  regeneratingImages,
  regeneratingMotion,
  divergentByShotId,
  onCompareDivergent,
  modelMissingShotIds,
  modelMissingLabel,
  staleShotIds,
}) => {
  const [expanded, setExpanded] = useState(true);
  const queryClient = useQueryClient();
  const updateScene = useUpdateScene(sequenceId);
  const createShot = useCreateShot(sequenceId);
  const reorderShots = useReorderShots(sequenceId);
  const softDeleteScene = useSoftDeleteScene(sequenceId);
  const softDeleteShot = useSoftDeleteShot(sequenceId);

  // null = not editing; a string = the in-progress title draft (#1108).
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [confirmSceneDelete, setConfirmSceneDelete] = useState(false);
  const [pendingShotDelete, setPendingShotDelete] = useState<ShotView | null>(
    null
  );

  // Stable identity so the mount-focus ref runs once, not per keystroke.
  const focusOnMount = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
    el?.select();
  }, []);

  // SceneListItem's memo ignores callback identity, so a move closure handed
  // to a card can be a render old. Reading the order through a ref keeps any
  // stale closure operating on the CURRENT shot order.
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const handleMoveShot = useCallback(
    (shotId: string, direction: 'up' | 'down') => {
      const ids = shotsRef.current.map((s) => s.id);
      const index = ids.indexOf(shotId);
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || swapWith < 0 || swapWith >= ids.length) return;
      const next = [...ids];
      const a = next[index];
      const b = next[swapWith];
      if (a === undefined || b === undefined) return;
      next[index] = b;
      next[swapWith] = a;
      reorderShots.mutate(
        { sceneId: scene.id, shotIds: next },
        {
          onError: (error) =>
            toast.error('Failed to reorder shots', {
              description: errorMessage(error),
            }),
        }
      );
    },
    [reorderShots, scene.id]
  );

  // Group the scene's shots into their render segments; every rendered segment
  // is bracketed as its own video (the video model lives on the segment, not the
  // scene), so the model shows here — even for a single shot (#986).
  const shotGroups = useMemo(
    () => groupShotsBySegment(shots, segmentsById),
    [shots, segmentsById]
  );

  const sceneLabel = useMemo(() => {
    const index = scene.orderIndex + 1;
    return plainSceneTitle(scene.title) || `Scene ${index}`;
  }, [scene.orderIndex, scene.title]);

  const handleSceneClick = (e: React.MouseEvent) => {
    onSelectScene(scene.id, e.metaKey || e.ctrlKey);
  };

  const commitTitle = () => {
    if (titleDraft === null) return;
    const next = plainSceneTitle(titleDraft);
    setTitleDraft(null);
    if (next === plainSceneTitle(scene.title)) return;
    updateScene.mutate(
      { sceneId: scene.id, title: next },
      {
        onError: (error) =>
          toast.error('Failed to rename scene', {
            description: errorMessage(error),
          }),
      }
    );
  };

  const handleAddShot = () => {
    createShot.mutate(
      { sceneId: scene.id },
      {
        onSuccess: (shot) => onSelectShot(shot.id),
        onError: (error) =>
          toast.error('Failed to add shot', {
            description: errorMessage(error),
          }),
      }
    );
  };

  const handleDeleteScene = () => {
    softDeleteScene.mutate(
      { sceneId: scene.id },
      {
        onSuccess: () => {
          setConfirmSceneDelete(false);
          if (
            isSceneSelected ||
            (selectedShotId && shots.some((s) => s.id === selectedShotId))
          ) {
            onClearSelection();
          }
          toast(`Removed ${sceneLabel}`, {
            duration: 60_000,
            action: {
              label: 'Undo',
              onClick: () =>
                void restoreScene(queryClient, {
                  sequenceId,
                  sceneId: scene.id,
                }).catch((error: Error) =>
                  toast.error('Failed to restore scene', {
                    description: errorMessage(error),
                  })
                ),
            },
          });
        },
        onError: (error) =>
          toast.error('Failed to remove scene', {
            description: errorMessage(error),
          }),
      }
    );
  };

  const handleConfirmShotDelete = (shot: ShotView) => {
    softDeleteShot.mutate(
      { shotId: shot.id },
      {
        onSuccess: () => {
          setPendingShotDelete(null);
          if (selectedShotId === shot.id) onClearSelection();
          toast(`Removed shot from ${sceneLabel}`, {
            duration: 60_000,
            action: {
              label: 'Undo',
              onClick: () =>
                void restoreShot(queryClient, {
                  sequenceId,
                  shotId: shot.id,
                }).catch((error: Error) =>
                  toast.error('Failed to restore shot', {
                    description: errorMessage(error),
                  })
                ),
            },
          });
        },
        onError: (error) =>
          toast.error('Failed to remove shot', {
            description: errorMessage(error),
          }),
      }
    );
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
      <div className="group/scene-header flex w-full items-start gap-2 px-3 py-2.5 hover:bg-muted/40">
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
        {titleDraft !== null ? (
          <Input
            ref={focusOnMount}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.currentTarget.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setTitleDraft(null);
              }
            }}
            maxLength={2000}
            aria-label="Scene title"
            className="h-7 flex-1 text-sm"
          />
        ) : (
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
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/scene-header:opacity-100 group-hover/scene-header:opacity-100 data-[state=open]:opacity-100"
              aria-label={`Scene actions for ${sceneLabel}`}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => setTitleDraft(plainSceneTitle(scene.title))}
            >
              <Pencil className="h-4 w-4" />
              Rename scene
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={createShot.isPending}
              onClick={handleAddShot}
            >
              <Plus className="h-4 w-4" />
              {createShot.isPending ? 'Adding shot…' : 'Add shot'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isFirst}
              onClick={() => onMoveScene(scene.id, 'up')}
            >
              <ArrowUp className="h-4 w-4" />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isLast}
              onClick={() => onMoveScene(scene.id, 'down')}
            >
              <ArrowDown className="h-4 w-4" />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirmSceneDelete(true)}
            >
              <Trash2 className="h-4 w-4" />
              Remove scene
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && shots.length > 0 && (
        <div className="flex flex-col gap-2 border-t px-3 py-2">
          {shotGroups.map((group) => {
            const items = group.shots.map((shot) => {
              const divergent = divergentByShotId.get(shot.id);
              const shotIndex = shots.findIndex((s) => s.id === shot.id);
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
                  onMoveUp={
                    shotIndex > 0
                      ? () => handleMoveShot(shot.id, 'up')
                      : undefined
                  }
                  onMoveDown={
                    shotIndex >= 0 && shotIndex < shots.length - 1
                      ? () => handleMoveShot(shot.id, 'down')
                      : undefined
                  }
                  onRequestDelete={() => setPendingShotDelete(shot)}
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

      <AlertDialog
        open={confirmSceneDelete}
        onOpenChange={setConfirmSceneDelete}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {sceneLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              The scene and its {shots.length}{' '}
              {shots.length === 1 ? 'shot' : 'shots'} are hidden from the
              sequence, playback and export. You can undo from the toast right
              after removing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={softDeleteScene.isPending}
              // Radix's Action closes the dialog on click; hold it open so the
              // pending state is reachable and a second click can't
              // double-submit. `onSuccess` closes it.
              onClick={(event) => {
                event.preventDefault();
                handleDeleteScene();
              }}
            >
              {softDeleteScene.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingShotDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingShotDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove this shot from {sceneLabel}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The shot and its prompts, stills and video are hidden from the
              sequence, playback and export. You can undo from the toast right
              after removing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={softDeleteShot.isPending}
              // See the scene twin: hold the dialog open across the mutation.
              onClick={(event) => {
                event.preventDefault();
                if (pendingShotDelete) {
                  handleConfirmShotDelete(pendingShotDelete);
                }
              }}
            >
              {softDeleteShot.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export const SceneGroup = memo(SceneGroupComponent);
