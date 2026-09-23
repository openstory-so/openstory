import type { AspectRatio } from '@/models/aspect-ratios';
import { plainSceneTitle } from '@/platform/markdown-plain';
import type { ShotView } from '@/shots/shot-view';
import { Button } from '@/ui/shadcn/button';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import { cn } from '@/ui/utils';
import { Link } from '@tanstack/react-router';
import { Clapperboard, PanelLeftOpen } from 'lucide-react';
import type { SceneSelection } from './scene-selection';
import { SceneThumbnail } from './scene-thumbnail';
import type { SceneWithScript } from './use-scenes';

const ringClass =
  'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The scenes list folded to a thumbnail rail (#1713) — navigation only. The
 * batch footer, reordering and titles stay in the full `SceneList`, which
 * remains mounted (CSS-hidden) beside this so its draft state survives.
 */
export const SceneRail: React.FC<{
  scenes?: SceneWithScript[];
  shots?: ShotView[];
  selection: SceneSelection;
  /** Shot under the sequence player's playhead (#1771). */
  playingShotId?: string;
  aspectRatio: AspectRatio;
  staleShotIds?: Set<string>;
  onExpand: () => void;
  className?: string;
}> = ({
  scenes = [],
  shots = [],
  selection,
  playingShotId,
  aspectRatio,
  staleShotIds,
  onExpand,
  className,
}) => {
  const isWholeSequence = selection.sceneIds.length === 0 && !selection.shotId;
  return (
    <nav
      aria-label="Scenes"
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-background',
        className
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-full shrink-0 rounded-none border-b"
        aria-label="Expand scenes list"
        title="Expand scenes list"
        onClick={onExpand}
      >
        <PanelLeftOpen className="size-4" />
      </Button>
      <Link
        from="/sequences/$id/scenes"
        search={(prev) => ({ ...prev, scenes: undefined, shot: undefined })}
        aria-label="Whole sequence"
        title="Whole sequence"
        aria-current={isWholeSequence ? 'true' : undefined}
        className={cn(
          'flex h-9 shrink-0 items-center justify-center border-b text-muted-foreground outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isWholeSequence && 'bg-primary/5 text-primary'
        )}
      >
        <Clapperboard className="size-4" aria-hidden />
      </Link>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col gap-3 p-2">
          {scenes.map((scene) => {
            const label =
              plainSceneTitle(scene.title) || `Scene ${scene.orderIndex + 1}`;
            const sceneSelected = selection.sceneIds.includes(scene.id);
            return (
              <li key={scene.id} className="flex flex-col gap-1">
                <Link
                  from="/sequences/$id/scenes"
                  search={(prev) => ({
                    ...prev,
                    scenes: scene.id,
                    shot: undefined,
                  })}
                  aria-label={label}
                  title={label}
                  aria-current={sceneSelected ? 'true' : undefined}
                  className={cn(
                    ringClass,
                    'flex min-h-6 items-center justify-center text-xs font-semibold tabular-nums text-muted-foreground hover:bg-muted/40',
                    sceneSelected && 'bg-primary/5 text-primary'
                  )}
                >
                  {scene.orderIndex + 1}
                </Link>
                {shots
                  .filter((shot) => shot.sceneId === scene.id)
                  .map((shot, i) => {
                    const shotLabel = `${label} — Shot ${shot.shotNumber ?? i + 1}`;
                    const active = shot.id === selection.shotId;
                    const playing = shot.id === playingShotId;
                    return (
                      <Link
                        key={shot.id}
                        from="/sequences/$id/scenes"
                        search={(prev) => ({
                          ...prev,
                          scenes: undefined,
                          shot: shot.id,
                        })}
                        title={playing ? `${shotLabel} (playing)` : shotLabel}
                        aria-current={active || playing ? 'true' : undefined}
                        data-playing={playing ? 'true' : undefined}
                        className={cn(
                          ringClass,
                          'relative block border-2 border-transparent',
                          active && 'border-primary',
                          playing && 'ring-2 ring-primary/60'
                        )}
                      >
                        <SceneThumbnail
                          thumbnailUrl={shot.image?.url}
                          previewThumbnailUrl={shot.previewThumbnailUrl}
                          thumbnailStatus={shot.frame.imageStatus || undefined}
                          videoUrl={shot.video?.url}
                          generationError={shot.frame.imageError}
                          alt={shotLabel}
                          aspectRatio={aspectRatio}
                          className="w-full rounded-sm"
                        />
                        {staleShotIds?.has(shot.id) && (
                          <span
                            title="Out of date since your last edit"
                            className="pointer-events-none absolute top-0.5 right-0.5 block size-2 rounded-full bg-amber-500 ring-2 ring-amber-500/30"
                          >
                            <span className="sr-only">
                              Out of date since your last edit
                            </span>
                          </span>
                        )}
                      </Link>
                    );
                  })}
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </nav>
  );
};
