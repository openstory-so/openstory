import { ScenesView } from '@/shots/ui/scenes-view';
import { getScenesFn } from '@/shots/scenes.fn';
import { getShotsFn } from '@/shots/shots.fn';
import { getSequenceFn } from '@/sequences/sequences.fn';
import { getGenerationPlanFn } from '@/sequences/generation-plan.fn';
import { generationPlanKeys } from '@/sequences/ui/use-generation-plan';
import { sceneKeys } from '@/shots/ui/use-scenes';
import { shotKeys } from '@/shots/ui/use-shots';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { scenesSearchSchema } from '@/shots/ui/scene-selection';
import { getCompatibleModel } from '@/models/models';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/models/resolve-asset-models';
import { shotPromptPreviewQueryOptions } from '@/shots/ui/shot-prompt-preview-query';
import { useSidebar } from '@/ui/shadcn/sidebar';
import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

export const Route = createFileRoute('/_app/sequences/$id/_workspace')({
  component: SequenceWorkspace,
  validateSearch: scenesSearchSchema,
  // FailureSummaryBanner classifies content-checker vs full-retry from the
  // shot list. Prefetch so the content banner is in the SSR HTML instead of
  // hydrating over a generic "Generation failed" from `shots ?? []`.
  loaderDeps: ({ search }) => ({ shot: search.shot }),
  loader: async ({ params, context: { queryClient }, deps }) => {
    const [shots, , sequence] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: shotKeys.list(params.id),
        queryFn: () => getShotsFn({ data: { sequenceId: params.id } }),
      }),
      queryClient.ensureQueryData({
        queryKey: sceneKeys.list(params.id),
        queryFn: () => getScenesFn({ data: { sequenceId: params.id } }),
      }),
      queryClient.ensureQueryData({
        queryKey: sequenceKeys.detail(params.id),
        queryFn: () => getSequenceFn({ data: { sequenceId: params.id } }),
      }),
    ]);
    // The footer reads the generation plan (#1817); prefetch it so the
    // continue footer is in the SSR HTML, and so the loader and the client
    // are one opinion (the loader used to derive its own stage).
    await queryClient.ensureQueryData({
      queryKey: generationPlanKeys.detail(params.id),
      queryFn: () => getGenerationPlanFn({ data: { sequenceId: params.id } }),
    });

    // Optimised prompt lives in the shot inspector. Prefetch the selected
    // shot's request so the collapsed header is in the SSR HTML instead of
    // popping in after a client fetch (same pattern as the failure banner).
    const selectedShot = deps.shot
      ? shots.find((shot) => shot.id === deps.shot)
      : undefined;
    if (selectedShot) {
      const imageModel = resolveImageModel({
        selectedVersionModel: selectedShot.image?.model,
        sequenceModel: sequence.imageModel,
      });
      const videoModel = getCompatibleModel(
        resolveVideoModel({
          selectedVersionModel: selectedShot.video?.model,
          sequenceModel: sequence.videoModel,
        }),
        sequence.aspectRatio
      );
      await queryClient.ensureQueryData(
        shotPromptPreviewQueryOptions({
          sequenceId: params.id,
          shotId: selectedShot.id,
          imageModel,
          videoModel,
          imagePrompt: selectedShot.imagePromptVersion?.text ?? '',
          motionPrompt: selectedShot.motionPrompt?.fullPrompt ?? '',
          generateAudio: true,
        })
      );
    }
  },
});

/**
 * The scenes workspace, and what opens inside it. A character, location or
 * element takes the place of the scene list and the canvas; the inspector on
 * the right is this one instance on every child route, so it stays put.
 */
function SequenceWorkspace() {
  const { id: sequenceId } = Route.useParams();
  const search = Route.useSearch();
  const onScenes = useMatch({
    from: '/_app/sequences/$id/_workspace/scenes',
    shouldThrow: false,
  });

  // The canvas needs the width (#1713): fold the app sidebar to icons on the
  // way in. It stays folded until the expand control (#1807) — a sidebar the
  // user reopens by hand stays open.
  const { setOpen } = useSidebar();
  const fold = useRef(setOpen);
  useEffect(() => {
    fold.current(false);
  }, []);

  return (
    <ScenesView
      sequenceId={sequenceId}
      search={search}
      detail={onScenes ? null : <Outlet />}
    />
  );
}
