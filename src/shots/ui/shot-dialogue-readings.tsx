/**
 * This shot's readings, fetched (#1657) — the data half of the presentational
 * pieces in `motion-dialogue-panel.tsx`. Mounted in the prompt editor and
 * under the shot's video; both share one query.
 */

import { useSequenceElements } from '@/cast/ui/use-sequence-elements';
import {
  cancelShotDialogueClaimFn,
  discardShotDialogueSectionFn,
  listShotDialogueClaimsFn,
  listShotDialogueSectionsFn,
  listShotDialogueVersionsFn,
  selectShotDialogueSectionFn,
  selectShotDialogueVersionFn,
} from '@/shots/shot-dialogue.fn';
import type { ShotView } from '@/shots/shot-view';
import { Skeleton } from '@/ui/shadcn/skeleton';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Suspense } from 'react';
import { toast } from 'sonner';
import {
  ShotDialogueBlock,
  ShotDialogueHistory,
  ShotReadingsList,
  ShotRecordingsInFlight,
} from './motion-dialogue-panel';
import { shotStalenessNamespace } from './use-shot-staleness';
import { shotKeys } from './use-shots';

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
  const discardReading = useMutation({
    mutationFn: (sectionId: string) =>
      discardShotDialogueSectionFn({ data: { sequenceId, shotId, sectionId } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: shotKeys.dialogueSections(shotId),
        }),
        // Discarding the current reading clears the shot's `audioClips`.
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]),
    onError: (error: Error) =>
      toast.error('Reading not discarded', { description: error.message }),
  });
  // Recordings in flight. Refreshed by the same realtime event as the list:
  // the key sits under `dialogueSections`.
  const { data: claims } = useSuspenseQuery({
    queryKey: shotKeys.dialogueClaims(shotId),
    queryFn: () => listShotDialogueClaimsFn({ data: { sequenceId, shotId } }),
  });
  const cancelClaim = useMutation({
    mutationFn: (claimId: string) =>
      cancelShotDialogueClaimFn({ data: { sequenceId, shotId, claimId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: shotKeys.dialogueClaims(shotId),
      }),
    onError: (error: Error) =>
      toast.error('Recording not cancelled', { description: error.message }),
  });
  return (
    <>
      <ShotRecordingsInFlight
        claims={claims}
        onCancel={(claimId) => cancelClaim.mutate(claimId)}
        cancellingId={cancelClaim.isPending ? cancelClaim.variables : null}
      />
      {/* History only where there is room to act on it: the prompt editor. */}
      {collapsible ? null : (
        <DialogueHistory sequenceId={sequenceId} shotId={shotId} />
      )}
      <ShotReadingsList
        readings={readings}
        onUse={(sectionId) => selectReading.mutate(sectionId)}
        onDiscard={(sectionId) => discardReading.mutate(sectionId)}
        usingId={selectReading.isPending ? selectReading.variables : null}
        collapsible={collapsible}
      />
    </>
  );
};

/** The shot's authored line history, and the way back to an earlier set. */
const DialogueHistory: React.FC<{ sequenceId: string; shotId: string }> = ({
  sequenceId,
  shotId,
}) => {
  const queryClient = useQueryClient();
  const { data: versions } = useSuspenseQuery({
    queryKey: shotKeys.dialogueVersions(shotId),
    queryFn: () => listShotDialogueVersionsFn({ data: { sequenceId, shotId } }),
  });
  const selectVersion = useMutation({
    mutationFn: (versionId: string) =>
      selectShotDialogueVersionFn({ data: { sequenceId, shotId, versionId } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: shotKeys.dialogueVersions(shotId),
        }),
        // Which readings match the lines moved with them.
        queryClient.invalidateQueries({
          queryKey: shotKeys.dialogueSections(shotId),
        }),
        // `shot.dialogue` rides the shots list; the clip now reads stale.
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]),
    onError: (error: Error) =>
      toast.error('Lines not restored', { description: error.message }),
  });
  return (
    <ShotDialogueHistory
      versions={versions.map((version) => ({
        id: version.id,
        source: version.source,
        createdAt: version.createdAt,
        selected: version.selectedAt !== null,
        lines: version.lines,
      }))}
      onUse={(versionId) => selectVersion.mutate(versionId)}
      usingId={selectVersion.isPending ? selectVersion.variables : null}
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
export const ShotDialogueUnderVideo: React.FC<{ shot: ShotView }> = ({
  shot,
}) => {
  const { data: elements } = useSequenceElements(shot.sequenceId);
  const clip = shot.audioClips?.[0] ?? null;
  return (
    <ShotDialogueBlock
      dialogue={shot.dialogue}
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
