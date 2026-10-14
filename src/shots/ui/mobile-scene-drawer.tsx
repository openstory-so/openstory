import { Button } from '@/ui/shadcn/button';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/shadcn/drawer';
import { shotDraftLabel } from '@/motion/draft-mode';
import { shownClipUrl } from '@/shots/shot-view';
import type { SceneWithScript } from './use-scenes';
import type { SceneSelection } from './scene-selection';
import { plainSceneTitle } from '@/platform/markdown-plain';
import { ChevronUp, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SceneList, type SceneListProps } from './scene-list';
import { SceneThumbnail } from './scene-thumbnail';

/**
 * Phone stand-in for the desktop sidebar: a bottom bar that names the
 * selection and opens a drawer hosting the same `SceneList` — scene groups,
 * segment brackets, whole-sequence row, batch footer — so the two surfaces
 * can't drift. The cog opens the inspector, which is a drawer on a phone.
 */
export const MobileSceneDrawer: React.FC<
  SceneListProps & {
    settingsOpen: boolean;
    onSettingsOpenChange: (open: boolean) => void;
  }
> = ({ settingsOpen, onSettingsOpenChange, ...listProps }) => {
  const { shots, scenes, selection, aspectRatio } = listProps;
  const selectedShotId = selection.shotId;
  const selectedSceneIds = selection.sceneIds;

  // The drawer is open *for* one selection. Every pick inside it is a
  // navigation (shot cards are links, scene headers and "Whole sequence" call
  // back), and `selection` is a new object after any of them — so the drawer
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
  const previewClipUrl = previewShot ? shownClipUrl(previewShot) : null;

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-1 border-t bg-background pr-2 pb-[env(safe-area-inset-bottom)]">
        <button
          type="button"
          data-testid="mobile-scene-nav"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-haspopup="dialog"
          aria-expanded={jumpOpen}
          aria-label={`${label}. Open scene list`}
          onClick={() => setOpenFor(selection)}
        >
          <SceneThumbnail
            thumbnailUrl={previewShot?.image?.url}
            previewThumbnailUrl={previewShot?.previewThumbnailUrl}
            thumbnailStatus={previewShot?.imageStatus || undefined}
            videoUrl={previewClipUrl}
            draftLabel={previewClipUrl ? shotDraftLabel(previewShot) : null}
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
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Open settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => onSettingsOpenChange(!settingsOpen)}
        >
          <Settings />
        </Button>
      </div>

      <Drawer
        showSwipeHandle
        open={jumpOpen}
        onOpenChange={(open) => setOpenFor(open ? selection : null)}
      >
        <DrawerContent className="pb-[env(safe-area-inset-bottom)] [--drawer-content-height:92dvh] data-[swipe-axis=y]:[--drawer-content-max-height:92dvh]">
          <DrawerTitle className="sr-only">Scenes</DrawerTitle>
          <SceneList
            {...listProps}
            scrollToSelection
            className="min-h-0 w-full flex-1 rounded-none border-0"
          />
        </DrawerContent>
      </Drawer>
    </>
  );
};
