import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { SceneSelection } from '@/lib/scenes/scene-selection';
import { plainSceneTitle } from '@/lib/utils/markdown-plain';
import { ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SceneList, type SceneListProps } from './scene-list';
import { SceneThumbnail } from './scene-thumbnail';

/**
 * Phone stand-in for the desktop sidebar: a bottom bar that names the
 * selection and opens a sheet hosting the same `SceneList` — scene groups,
 * segment brackets, whole-sequence row, batch footer — so the two surfaces
 * can't drift.
 */
export const MobileSceneDrawer: React.FC<SceneListProps> = (listProps) => {
  const { shots, scenes, selection, aspectRatio } = listProps;
  const selectedShotId = selection.shotId;
  const selectedSceneIds = selection.sceneIds;

  // The sheet is open *for* one selection. Every pick inside it is a
  // navigation (shot cards are links, scene headers and "Whole sequence" call
  // back), and `selection` is a new object after any of them — so the sheet
  // closes itself without wiring a close into each row.
  const [openFor, setOpenFor] = useState<SceneSelection | null>(null);
  const jumpOpen = openFor === selection;

  const scenesById = useMemo(() => {
    const map = new Map<string, SceneWithScript>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);

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
  const sceneTitle =
    plainSceneTitle(focusedScene?.title) || `Scene ${sceneNumber}`;
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

  return (
    <>
      <button
        type="button"
        data-testid="mobile-scene-nav"
        className="fixed inset-x-0 bottom-0 z-40 flex min-h-11 items-center gap-3 border-t bg-background px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-haspopup="dialog"
        aria-expanded={jumpOpen}
        aria-label={`${label}. Open scene list`}
        onClick={() => setOpenFor(selection)}
      >
        <SceneThumbnail
          thumbnailUrl={previewShot?.image?.url}
          previewThumbnailUrl={previewShot?.previewThumbnailUrl}
          thumbnailStatus={previewShot?.frame.imageStatus || undefined}
          videoUrl={
            previewShot?.videoStatus === 'completed'
              ? previewShot.video?.url
              : null
          }
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

      <Sheet
        open={jumpOpen}
        onOpenChange={(open) => setOpenFor(open ? selection : null)}
      >
        <SheetContent
          side="bottom"
          className="flex min-h-0 flex-col gap-0 overflow-hidden pb-[env(safe-area-inset-bottom)] data-[side=bottom]:h-[70dvh]"
        >
          <SheetTitle className="sr-only">Scenes</SheetTitle>
          <SceneList
            {...listProps}
            scrollToSelection
            className="min-h-0 w-full flex-1 rounded-none border-0"
          />
        </SheetContent>
      </Sheet>
    </>
  );
};
