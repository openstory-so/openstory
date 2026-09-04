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
import { getUpdateStalePreviewFn } from '@/functions/shots';
import type { ShotStaleness } from '@/hooks/use-shot-staleness';
import { useShowCosts } from '@/hooks/use-show-costs';
import {
  addMicros,
  microsToDisplayUsd,
  ZERO_MICROS,
  type Microdollars,
} from '@/lib/billing/money';
import type { UpdateStalePreview } from '@/lib/shots/update-stale-preview';
import {
  UPDATE_STALE_DEPTH_LABELS,
  type UpdateStaleDepth,
} from '@/lib/shots/update-stale-depth';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

type UpdateAllScope = {
  sequenceId: string;
  sceneId?: string;
  shotId?: string;
};

type UpdateAllDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Confirm with the chosen cascade depth; the dialog closes itself. */
  onConfirm: (depth: UpdateStaleDepth) => void;
  /** Staleness of each out-of-date shot in scope — supplies the causes (#1194). */
  staleShots: ShotStaleness[];
  /** What the dry-run preview plans over (shot / scene / sequence). */
  scope: UpdateAllScope;
  /** In-scope display numbers, for "shots 2, 3 & 4" labels. */
  shotNumberById?: ReadonlyMap<string, number>;
};

/** "Changed: Script, Character "Woman"" — deduped across shots, or null. */
export const describeCauses = (staleShots: ShotStaleness[]): string | null => {
  const causes = [...new Set(staleShots.flatMap((s) => s.causes))];
  return causes.length > 0 ? `Changed: ${causes.join(', ')}` : null;
};

/** "shot 2" / "shots 2, 3 & 4" / "this shot" at shot scope. */
export const shotsLabel = (
  shotIds: string[],
  numberById: ReadonlyMap<string, number> | undefined,
  singleShotScope: boolean
): string => {
  if (singleShotScope) return 'this shot';
  const numbers = shotIds
    .map((id) => numberById?.get(id))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return `${shotIds.length} shots`;
  if (numbers.length === 1) return `shot ${numbers[0]}`;
  return `shots ${numbers.slice(0, -1).join(', ')} & ${numbers[numbers.length - 1]}`;
};

/**
 * Immediate checkbox levels from the client staleness map (#1432). The dry-run
 * preview is a server `computePlan` at max depth — on a remote D1 that can
 * take long enough that the dialog used to render "…" with no checkboxes.
 * These two levels are what the client already knows; video/music arrive
 * when the preview does.
 */
export const levelsFromStaleShots = (
  staleShots: ShotStaleness[]
): Array<{ depth: UpdateStaleDepth; label: string }> => {
  const prompts = staleShots.some(
    (s) => s.visualPrompt === 'stale' || s.motionPrompt === 'stale'
  );
  const images = staleShots.some(
    (s) => s.thumbnail === 'stale' || s.visualPrompt === 'stale'
  );
  const levels: Array<{ depth: UpdateStaleDepth; label: string }> = [];
  if (prompts) levels.push({ depth: 'prompts', label: 'Prompts' });
  if (images) levels.push({ depth: 'images', label: 'Images' });
  return levels;
};

/** Levels with something to do, in cascade order, with their own additions. */
export const previewLevels = (
  preview: UpdateStalePreview,
  numberById: ReadonlyMap<string, number> | undefined,
  singleShotScope: boolean
): Array<{ depth: UpdateStaleDepth; label: string }> => {
  const label = (ids: string[]) => shotsLabel(ids, numberById, singleShotScope);
  const levels: Array<{ depth: UpdateStaleDepth; label: string }> = [];
  const prompts: string[] = [];
  if (preview.visualPromptShotIds.length > 0)
    prompts.push(`Image prompts for ${label(preview.visualPromptShotIds)}`);
  if (preview.motionPromptShotIds.length > 0)
    prompts.push(`Motion prompts for ${label(preview.motionPromptShotIds)}`);
  if (prompts.length > 0)
    levels.push({ depth: 'prompts', label: prompts.join(' · ') });
  if (preview.imageShotIds.length > 0)
    levels.push({
      depth: 'images',
      label: `Images for ${label(preview.imageShotIds)}`,
    });
  if (preview.videoShotIds.length > 0)
    levels.push({
      depth: 'video',
      label: `Videos for ${label(preview.videoShotIds)}`,
    });
  if (preview.musicTrack || preview.musicPrompt)
    levels.push({
      depth: 'music',
      label: preview.musicTrack ? 'Music prompt and track' : 'Music prompt',
    });
  return levels;
};

const costLabel = (cost: Microdollars | null | undefined): string | null =>
  cost == null ? null : `~${microsToDisplayUsd(cost)}`;

const RANK: Record<UpdateStaleDepth, number> = {
  prompts: 0,
  images: 1,
  video: 2,
  music: 3,
};

/**
 * "Update all" confirmation (#1085/#1194/#1432). Leads with WHAT changed,
 * then one checkbox per level that has work. Checkboxes render immediately
 * from the client staleness map; the server dry-run refines labels, costs,
 * and video/music when it lands. Levels cascade (images need prompts,
 * videos need images), so ticking a level locks every shallower one on.
 * Only the deepest tick is sent — the run's `depth`. Native inputs for
 * keyboard/AT semantics.
 */
export const UpdateAllDialog: React.FC<UpdateAllDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  staleShots,
  scope,
  shotNumberById,
}) => {
  // 'images' is the middle-ground default — the closest match to what
  // "Update all" did before depths existed.
  const [depth, setDepth] = useState<UpdateStaleDepth | null>('images');
  const { showCosts } = useShowCosts();
  const singleShotScope = scope.shotId != null;

  const {
    data: preview,
    isError,
    isPending,
  } = useQuery({
    queryKey: [
      'update-stale-preview',
      scope.sequenceId,
      scope.sceneId,
      scope.shotId,
    ],
    queryFn: () => getUpdateStalePreviewFn({ data: scope }),
    enabled: open && scope.sequenceId !== '',
    staleTime: 30_000,
  });

  const clientLevels = levelsFromStaleShots(staleShots);
  const levels = preview
    ? previewLevels(preview, shotNumberById, singleShotScope)
    : clientLevels;
  // Snap the default to a level that exists: the deepest at or above it.
  const available =
    depth == null ? [] : levels.filter((l) => RANK[l.depth] <= RANK[depth]);
  // Preview failed: fall back to the pre-preview behaviour — a plain confirm
  // at the old default depth — rather than blocking the update on a preview.
  const selectedDepth =
    available[available.length - 1]?.depth ??
    (isError && depth != null ? 'images' : null);
  const checked = (d: UpdateStaleDepth) =>
    selectedDepth != null && RANK[d] <= RANK[selectedDepth];
  const total = levels
    .filter((l) => checked(l.depth))
    .reduce<Microdollars | null>((acc, l) => {
      const c = preview?.costByLevel[l.depth] ?? null;
      return acc == null || c == null ? null : addMicros(acc, c);
    }, ZERO_MICROS);

  const toggle = (d: UpdateStaleDepth, on: boolean) => {
    if (on) {
      setDepth(d);
      return;
    }
    // Unticking a level drops it and everything deeper.
    const shallower = levels.filter((l) => RANK[l.depth] < RANK[d]);
    setDepth(shallower[shallower.length - 1]?.depth ?? null);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update out-of-date items</AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-1">
            <span className="text-foreground">
              {describeCauses(staleShots) ??
                'Inputs changed since these were generated.'}
            </span>
            <span>Regenerate:</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">What to regenerate</legend>
          {isError && (
            <span className="text-xs text-muted-foreground">
              Couldn’t compute the exact plan — showing out-of-date prompts and
              images.
            </span>
          )}
          {levels.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {isPending ? '…' : 'Nothing to regenerate.'}
            </span>
          ) : (
            levels.map((level, index) => {
              const isChecked = checked(level.depth);
              // Shallower levels are prerequisites of a deeper tick.
              const locked =
                selectedDepth != null &&
                RANK[level.depth] < RANK[selectedDepth];
              const cost = showCosts
                ? costLabel(preview?.costByLevel[level.depth])
                : null;
              return (
                <label
                  key={level.depth}
                  htmlFor={`update-all-level-${level.depth}`}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
                    'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
                    isChecked
                      ? 'border-primary/40 bg-primary/5'
                      : 'hover:bg-muted/50',
                    locked && 'cursor-default'
                  )}
                >
                  <input
                    id={`update-all-level-${level.depth}`}
                    type="checkbox"
                    checked={isChecked}
                    disabled={locked}
                    onChange={(e) =>
                      toggle(level.depth, e.currentTarget.checked)
                    }
                    aria-label={UPDATE_STALE_DEPTH_LABELS[level.depth]}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex min-w-0 grow items-baseline justify-between gap-2">
                    <span className="text-sm">
                      {index > 0 && (
                        <span className="text-muted-foreground">+ </span>
                      )}
                      {level.label}
                    </span>
                    {cost && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {cost}
                      </span>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </fieldset>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={selectedDepth == null}
            onClick={() => selectedDepth && onConfirm(selectedDepth)}
          >
            {showCosts && selectedDepth != null && total != null
              ? `Update · ~${microsToDisplayUsd(total)}`
              : 'Update'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
