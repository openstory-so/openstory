import {
  ascendSelection,
  clearSelection,
  DEFAULT_CANVAS_VIEW,
  parseSelectionFromSearch,
  selectScene,
  selectShot,
  type CanvasView,
  type SceneFacet,
  type SceneSelection,
  type ScenesSearch,
  selectionToSearchParams,
  toggleSceneInSelection,
} from '@/lib/scenes/scene-selection';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

type UseSceneSelectionOptions = {
  search: ScenesSearch;
  sequenceId: string;
};

export function useSceneSelection({
  search,
  sequenceId,
}: UseSceneSelectionOptions) {
  const navigate = useNavigate();

  const { scenes, shot } = search;
  const selection = useMemo(
    () => parseSelectionFromSearch({ scenes, shot }),
    [scenes, shot]
  );

  const view = search.view ?? DEFAULT_CANVAS_VIEW;

  const setSelection = useCallback(
    (next: SceneSelection, facet?: SceneFacet, replace = false) => {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: sequenceId },
        search: selectionToSearchParams(
          next,
          facet ?? search.facet,
          search.view
        ) as Record<string, string | undefined>,
        replace,
      });
    },
    [navigate, sequenceId, search.facet, search.view]
  );

  const setView = useCallback(
    (next: CanvasView) => {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: sequenceId },
        search: selectionToSearchParams(selection, search.facet, next),
        replace: true,
      });
    },
    [navigate, sequenceId, selection, search.facet]
  );

  const handleSelectScene = useCallback(
    (sceneId: string, additive: boolean) => {
      setSelection(toggleSceneInSelection(selection, sceneId, additive));
    },
    [selection, setSelection]
  );

  /** Idempotent — for surfaces where selection follows focus rather than being
   *  a click-to-toggle (see `selectScene`). */
  const handleFocusScene = useCallback(
    (sceneId: string) => {
      if (
        selection.sceneIds.length === 1 &&
        selection.sceneIds[0] === sceneId
      ) {
        return;
      }
      setSelection(selectScene(sceneId));
    },
    [selection, setSelection]
  );

  const handleSelectShot = useCallback(
    (shotId: string) => {
      setSelection(selectShot(shotId));
    },
    [setSelection]
  );

  const handleClearSelection = useCallback(() => {
    setSelection(clearSelection());
  }, [setSelection]);

  const handleAscendSelection = useCallback(
    (shots: ReadonlyArray<{ id: string; sceneId: string | null }>) => {
      const next = ascendSelection(selection, shots);
      if (next) setSelection(next);
      return next !== null;
    },
    [selection, setSelection]
  );

  const setFacet = useCallback(
    (facet: SceneFacet) => {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: sequenceId },
        search: selectionToSearchParams(selection, facet, search.view),
        replace: true,
      });
    },
    [navigate, sequenceId, selection, search.view]
  );

  return {
    selection,
    setSelection,
    handleSelectScene,
    handleFocusScene,
    handleSelectShot,
    handleClearSelection,
    handleAscendSelection,
    facet: search.facet,
    setFacet,
    view,
    setView,
  };
}
