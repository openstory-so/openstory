import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { Input } from '@/ui/shadcn/input';
import {
  restoreScene,
  restoreShot,
  useCreateShot,
  useReorderShots,
  useSoftDeleteScene,
  useSoftDeleteShot,
  useUpdateScene,
} from './use-scene-structure';
import { videoModelDisplayName, type ImageToVideoModel } from '@/models/models';
import { durationGridForModel } from '@/motion/model-capabilities';
import { snapDuration } from '@/motion/snap-duration';

const GROK_IMAGINE: ImageToVideoModel = 'grok_imagine_video_1_5';
const DEFAULT_ADD_SHOT_MS = 3000;
import { formatSeconds } from '@/sequences/ui/target-duration-chip';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { SceneWithScript } from './use-scenes';
import type { ShotVariant } from '@/platform/server/db/schema';
import { errorMessage } from '@/platform/errors';
import {
  groupShotsForSceneList,
  type SequenceSegment,
} from '@/shots/scene-segments';
import { packedClipWindows } from '@/shots/packed-clip-window';
import type { ShotView } from '@/shots/shot-view';
import { cn } from '@/ui/utils';
import { plainSceneTitle } from '@/platform/markdown-plain';
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
import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  /** Shot under the sequence player's playhead (#1771). */
  playingShotId?: string;
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
  /** Shots with stale prompts/image (#1077) — amber corner dot. */
  staleShotIds?: Set<string>;
  /** Sequence video model — planned-pack preview and leftover snap/Grok. */
  videoModel: ImageToVideoModel;
  /** Shot ids the user routed to Grok on a leftover planned pack. */
  leftoverGrokShotIds?: ReadonlySet<string>;
  onLeftoverGrokChange?: (shotIds: readonly string[], useGrok: boolean) => void;
  /** A run is on: a scene with no shots yet is still being listed (#1593). */
  isAnalyzing?: boolean;
};

/** Running time of a shot list, from `shots.durationMs` (#1593). */
export function sumShotSeconds(
  shots: ReadonlyArray<{ durationMs: number | null }>
): number {
  return shots.reduce((sum, shot) => sum + (shot.durationMs ?? 0), 0) / 1000;
}

type SegmentBracketProps = {
  kind: 'rendered' | 'planned';
  model: string | null;
  shotCount: number;
  stale?: boolean;
  /** Planned pack under the model floor — snap vs Grok. */
  leftover?: {
    editorialSeconds: number;
    packingModel: ImageToVideoModel;
    useGrok: boolean;
    onUseGrokChange: (useGrok: boolean) => void;
  };
  children: ReactNode;
};

/**
 * Film frame around shots that share one clip — solid for a clip that exists,
 * dashed for the pack generate will submit (#1510).
 */
const SegmentBracket: React.FC<SegmentBracketProps> = ({
  kind,
  model,
  shotCount,
  stale = false,
  leftover,
  children,
}) => {
  const planned = kind === 'planned';
  const displayModel = leftover?.useGrok ? GROK_IMAGINE : model;
  const modelName = displayModel ? videoModelDisplayName(displayModel) : null;
  const label = modelName ?? 'Video';
  const snappedSeconds = leftover
    ? snapDuration(leftover.editorialSeconds, leftover.packingModel)
    : null;
  return (
    <div
      data-testid="segment-bracket"
      data-segment-kind={kind}
      data-below-min={leftover ? 'true' : undefined}
      aria-label={
        planned
          ? `Will generate with ${label}, ${shotCount} shots`
          : `${label}${shotCount > 1 ? `, ${shotCount} shots` : ''}`
      }
      className={cn(
        'flex flex-col gap-2 rounded-md border p-2',
        planned
          ? 'border-dashed border-border/60'
          : 'border-border/60 bg-muted/20'
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Film className="h-3 w-3 shrink-0" />
        {leftover ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'flex min-w-0 items-center gap-0.5 truncate font-medium',
                planned ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {label}
              <ChevronDown className="h-3 w-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => leftover.onUseGrokChange(false)}
              >
                {videoModelDisplayName(leftover.packingModel)} · billed as{' '}
                {formatSeconds(snappedSeconds ?? leftover.editorialSeconds)}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => leftover.onUseGrokChange(true)}>
                {videoModelDisplayName(GROK_IMAGINE)} ·{' '}
                {formatSeconds(leftover.editorialSeconds)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span
            className={cn(
              'truncate font-medium',
              planned ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {label}
          </span>
        )}
        {shotCount > 1 && <span className="shrink-0">{shotCount} shots</span>}
        {!planned && stale && (
          <Badge
            variant="outline"
            className="ml-auto shrink-0 px-1 py-0 text-[10px]"
          >
            Stale
          </Badge>
        )}
      </div>
      {leftover && snappedSeconds != null && (
        <p className="text-[11px] text-muted-foreground">
          {leftover.useGrok
            ? `${formatSeconds(leftover.editorialSeconds)} clip — Grok Imagine can render it at that length.`
            : `${formatSeconds(leftover.editorialSeconds)} clip — ${videoModelDisplayName(leftover.packingModel)} min is ${formatSeconds(Math.min(...durationGridForModel(leftover.packingModel)))}. Billed as ${formatSeconds(snappedSeconds)}.`}
        </p>
      )}
      {children}
    </div>
  );
};

const SceneGroupComponent: React.FC<SceneGroupProps> = ({
  scene,
  shots,
  sequenceId,
  segmentsById,
  isSceneSelected,
  selectedShotId,
  playingShotId,
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
  staleShotIds,
  videoModel,
  leftoverGrokShotIds,
  onLeftoverGrokChange,
  isAnalyzing = false,
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
  // scene), so the model shows here — even for a single shot (#986). Unrendered
  // runs are tiled with the generate-picker model so a dashed bracket previews
  // the next pack (#1510).
  const shotGroups = useMemo(
    () => groupShotsForSceneList(shots, segmentsById, videoModel),
    [shots, segmentsById, videoModel]
  );

  const sceneLabel = useMemo(() => {
    const index = scene.orderIndex + 1;
    return plainSceneTitle(scene.title) || `Scene ${index}`;
  }, [scene.orderIndex, scene.title]);
  // A scene's length IS the sum of its shots (#1593).
  const sceneSeconds = sumShotSeconds(shots);

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
      {
        sceneId: scene.id,
        durationMs: DEFAULT_ADD_SHOT_MS,
      },
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
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {shots.length === 0 && isAnalyzing
                  ? 'listing shots…'
                  : `${shots.length} ${shots.length === 1 ? 'shot' : 'shots'} · ${formatSeconds(sceneSeconds)}`}
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
            const windows =
              group.segment && group.shots.length > 1
                ? packedClipWindows(group.shots)
                : [];
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
                  isPlaying={shot.id === playingShotId}
                  variant="horizontal"
                  isRegeneratingImage={regeneratingImages.has(shot.id)}
                  isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                  divergentVariantId={divergent?.id}
                  onCompareDivergent={
                    divergent
                      ? () => onCompareDivergent?.(divergent)
                      : undefined
                  }
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
                  videoStartSeconds={
                    windows.find((window) => window.id === shot.id)
                      ?.startSeconds
                  }
                />
              );
            });

            const key = group.segmentId ?? `unassigned-${group.shots[0]?.id}`;
            // Rendered clip → solid bracket. Planned pack (2+ unrendered shots
            // that generate will cover) → the same chrome, dashed. A lonely
            // unrendered shot stays flat — the footer already shows the model.
            if (group.segment) {
              return (
                <SegmentBracket
                  key={key}
                  kind="rendered"
                  model={group.segment.model}
                  shotCount={group.shots.length}
                  stale={group.segment.stale}
                >
                  {items}
                </SegmentBracket>
              );
            }
            if (group.plannedModel) {
              const leftover = group.belowMin
                ? {
                    editorialSeconds:
                      group.shots.reduce(
                        (sum, shot) => sum + (shot.durationMs ?? 0),
                        0
                      ) / 1000,
                    packingModel: group.plannedModel,
                    useGrok: group.shots.some((shot) =>
                      leftoverGrokShotIds?.has(shot.id)
                    ),
                    onUseGrokChange: (useGrok: boolean) =>
                      onLeftoverGrokChange?.(
                        group.shots.map((shot) => shot.id),
                        useGrok
                      ),
                  }
                : undefined;
              return (
                <SegmentBracket
                  key={key}
                  kind="planned"
                  model={leftover?.useGrok ? GROK_IMAGINE : group.plannedModel}
                  shotCount={group.shots.length}
                  leftover={leftover}
                >
                  {items}
                </SegmentBracket>
              );
            }
            return <Fragment key={key}>{items}</Fragment>;
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
