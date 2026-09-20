/**
 * This shot's readings, fetched (#1657) — the data half of the presentational
 * pieces in `motion-dialogue-panel.tsx`. Mounted in the prompt editor and
 * under the shot's video; both share one query.
 */

import { useSequenceElements } from '@/cast/ui/use-sequence-elements';
import {
  listShotDialogueSectionsFn,
  selectShotDialogueSectionFn,
} from '@/shots/shot-dialogue.fn';
import { dialogueForShot } from '@/shots/shot-list-pass';
import type { ShotView } from '@/shots/shot-view';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Suspense } from 'react';
import { toast } from 'sonner';
import { ShotDialogueBlock, ShotReadingsList } from './motion-dialogue-panel';
import { shotKeys } from './use-shots';
import type { SceneWithScript } from './use-scenes';

type ReadingsProps = {
  sequenceId: string;
  shotId: string;
  collapsible?: boolean;
};

const Readings: React.FC<ReadingsProps> = ({
  sequenceId,
  shotId,
  collapsible,
}) => {
  const queryClient = useQueryClient();
  // Keyed by shot alone: a new recording invalidates it (the realtime
  // `dialogue-audio` event), so the list on screen stays put while it
  // refetches instead of dropping back to the fallback.
  const { data: readings } = useSuspenseQuery({
    queryKey: shotKeys.dialogueSections(shotId),
    queryFn: () => listShotDialogueSectionsFn({ data: { sequenceId, shotId } }),
  });
  const selectReading = useMutation({
    mutationFn: (sectionId: string) =>
      selectShotDialogueSectionFn({ data: { sequenceId, shotId, sectionId } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: shotKeys.dialogueSections(shotId),
        }),
        // The shot's `audioClips` ride the shots list.
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
      ]),
    onError: (error: Error) =>
      toast.error('Reading not used', { description: error.message }),
  });
  return (
    <ShotReadingsList
      readings={readings}
      onUse={(sectionId) => selectReading.mutate(sectionId)}
      usingId={selectReading.isPending ? selectReading.variables : null}
      collapsible={collapsible}
    />
  );
};

// The fallback is what the list most often resolves to, so nothing moves when
// it lands: one h-8 row under the video, nothing in the prompt editor (a lone
// selected reading renders no list).
export const ShotDialogueReadings: React.FC<ReadingsProps> = (props) => (
  <Suspense
    fallback={props.collapsible ? <Skeleton className="h-8 w-full" /> : null}
  >
    <Readings {...props} />
  </Suspense>
);

/** Lines, current audio and readings for the shot whose video is on the canvas. */
export const ShotDialogueUnderVideo: React.FC<{
  shot: ShotView;
  scene: SceneWithScript | undefined;
}> = ({ shot, scene }) => {
  const { data: elements } = useSequenceElements(shot.sequenceId);
  // Same ladder as the prompt editor: the motion prompt's lines, else the
  // script's lines for this shot (#1585).
  const dialogue = shot.motionPrompt?.dialogue ?? {
    presence: true,
    lines: dialogueForShot(scene?.script?.dialogue, shot.shotNumber ?? 1),
  };
  const clip = shot.audioClips?.[0] ?? null;
  return (
    <ShotDialogueBlock
      dialogue={dialogue}
      elements={elements}
      clip={clip}
      readings={
        <ShotDialogueReadings
          sequenceId={shot.sequenceId}
          shotId={shot.id}
          collapsible
        />
      }
    />
  );
};
