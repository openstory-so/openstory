/**
 * This shot's readings, fetched (#1657) — the data half of the presentational
 * pieces in `motion-dialogue-panel.tsx`. Mounted in the prompt editor and
 * under the shot's video; both share one query.
 */

import { useSequenceElements } from '@/cast/ui/use-sequence-elements';
import {
  useGenerateCharacterVoice,
  useSequenceCharacters,
  useSetCharacterVoiceEnabled,
} from '@/cast/ui/use-sequence-characters';
import {
  useSeedVoices,
  useVoiceDesignAvailable,
} from '@/cast/ui/use-voice-design-available';
import { speakersWithoutVoice } from '@/cast/voice';
import { SEED_VOICE_DEFAULT_TAKES } from '@/cast/seed-voice';
import { VOICE_DESIGN_COST } from '@/billing/elevenlabs-pricing';
import { seedVoiceEstimate } from '@/billing/seed-speech-pricing';
import { ActionCost } from '@/billing/ui/action-cost';
import {
  cancelShotDialogueClaimFn,
  discardShotDialogueSectionFn,
  listShotDialogueClaimsFn,
  listShotDialogueSectionsFn,
  listShotDialogueVersionsFn,
  regenerateShotDialogueFn,
  saveShotDialogueFn,
  selectShotDialogueSectionFn,
  selectShotDialogueVersionFn,
} from '@/shots/shot-dialogue.fn';
import type { ShotView } from '@/shots/shot-view';
import { Button } from '@/ui/shadcn/button';
import { Skeleton } from '@/ui/shadcn/skeleton';
import type { QueryClient } from '@tanstack/react-query';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Suspense } from 'react';
import { toast } from 'sonner';
import type { DialogueLine } from '@/shots/scene-analysis.schema';
import {
  DialogueLinesEditor,
  ShotDialogueBlock,
  ShotDialogueHistory,
  ShotReadingsList,
  ShotMissingVoices,
  ShotRecordingsInFlight,
  shotSpokenByNote,
} from './motion-dialogue-panel';
import { StalenessIndicator } from './staleness/staleness-indicator';
import { segmentKeys } from './use-segments';
import { shotStalenessNamespace } from './use-shot-staleness';
import { shotKeys } from './use-shots';

type ReadingsProps = {
  sequenceId: string;
  shotId: string;
  collapsible?: boolean;
  /**
   * What the shot says (#1773). Off Generated (video model, audio element)
   * the reading is not in use, so a note stands in for the staleness line and
   * the Generate button; a speaker with no voice is offered one first.
   */
  lines: readonly DialogueLine[];
};

const Readings: React.FC<ReadingsProps> = ({
  sequenceId,
  shotId,
  collapsible,
  lines,
}) => {
  const queryClient = useQueryClient();
  const spokenBy = shotSpokenByNote(lines);
  const { data: characters } = useSequenceCharacters(sequenceId);
  const voiceDesign = useVoiceDesignAvailable();
  const seedVoices = useSeedVoices();
  const enableVoice = useSetCharacterVoiceEnabled();
  const designVoice = useGenerateCharacterVoice();
  const unvoiced = spokenBy
    ? []
    : speakersWithoutVoice(lines, characters ?? []);
  const generateVoice = async (characterId: string) => {
    const character = unvoiced.find((c) => c.id === characterId);
    try {
      // An explicit opt-in, so the voice shows on the character's page even
      // when the sequence default is off.
      if (character?.useVoice !== true) {
        await enableVoice.mutateAsync({
          sequenceId,
          characterId,
          enabled: true,
        });
      }
      await designVoice.mutateAsync({
        sequenceId,
        characterId,
        takes: SEED_VOICE_DEFAULT_TAKES,
      });
    } catch (error) {
      toast.error('Voice not generated', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
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
        // The video rendered with the old clip now reads stale.
        queryClient.invalidateQueries({
          queryKey: segmentKeys.list(sequenceId),
        }),
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
        // The video rendered with the old clip now reads stale.
        queryClient.invalidateQueries({
          queryKey: segmentKeys.list(sequenceId),
        }),
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
      toast.error('Generation not cancelled', { description: error.message }),
  });
  // The claim lands a moment after the trigger; the realtime event then
  // refetches it and "Generating…" takes over from the button.
  const record = useMutation({
    mutationFn: () =>
      regenerateShotDialogueFn({ data: { sequenceId, shotId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: shotKeys.dialogueClaims(shotId),
      }),
    onError: (error: Error) =>
      toast.error('Dialogue not generated', { description: error.message }),
  });
  const recording = claims.some((claim) => claim.willBecomeCurrent);
  // The shot's audio is its current reading; it is out of date once the voice
  // or the lines it was generated from moved.
  const current = readings.find((reading) => reading.selected);
  const staleBecause = current?.mismatch ?? null;
  return (
    <>
      {spokenBy ? (
        <p className="text-xs text-muted-foreground">{spokenBy}</p>
      ) : recording ? null : unvoiced.length > 0 ? (
        <ShotMissingVoices
          speakers={unvoiced.map((character) => ({
            characterId: character.id,
            name: character.name,
            generating:
              character.pendingPromoteVoiceVersionId != null ||
              (designVoice.isPending &&
                designVoice.variables.characterId === character.id),
          }))}
          onGenerate={voiceDesign ? (id) => void generateVoice(id) : null}
          cost={
            <ActionCost
              estimate={
                seedVoices
                  ? seedVoiceEstimate(SEED_VOICE_DEFAULT_TAKES)
                  : VOICE_DESIGN_COST
              }
            />
          }
        />
      ) : staleBecause ? (
        <StalenessIndicator
          entityType="shot"
          density="status-line"
          artifact="audio"
          message={
            staleBecause === 'voice'
              ? 'Dialogue out of date — voice changed'
              : 'Dialogue out of date — lines changed'
          }
          actionLabel="Regenerate"
          isRegenerating={record.isPending}
          onRegenerate={() => record.mutate()}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={record.isPending}
          onClick={() => record.mutate()}
        >
          {record.isPending
            ? 'Starting…'
            : readings.length > 0
              ? 'Regenerate dialogue'
              : 'Generate dialogue'}
        </Button>
      )}
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

/**
 * Everything that reads a shot's lines, after they moved (a restore or an
 * edit): its history, which readings match, `shot.dialogue` on the shots list,
 * and the video rendered from the old lines.
 */
const invalidateLinesMoved = (
  queryClient: QueryClient,
  sequenceId: string,
  shotId: string
) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: shotKeys.dialogueVersions(shotId),
    }),
    queryClient.invalidateQueries({
      queryKey: shotKeys.dialogueSections(shotId),
    }),
    queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
    queryClient.invalidateQueries({ queryKey: segmentKeys.list(sequenceId) }),
    queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) }),
    queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
  ]);

/** Same speakers, words and tone — voice bindings aside. */
const sameWords = (
  a: readonly DialogueLine[],
  b: readonly DialogueLine[]
): boolean =>
  a.length === b.length &&
  a.every((line, index) => {
    const other = b.at(index);
    return (
      other !== undefined &&
      line.character === other.character &&
      line.line === other.line &&
      line.tone === other.tone
    );
  });

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
    onSuccess: () => invalidateLinesMoved(queryClient, sequenceId, shotId),
    onError: (error: Error) =>
      toast.error('Lines not restored', { description: error.message }),
  });
  return (
    <ShotDialogueHistory
      versions={versions.map((version, index) => {
        // Newest first, so the version this one replaced is the next row.
        const before = versions[index + 1];
        return {
          id: version.id,
          source: version.source,
          createdAt: version.createdAt,
          selected: version.selectedAt !== null,
          lines: version.lines,
          voiceOnly:
            before !== undefined && sameWords(version.lines, before.lines),
        };
      })}
      onUse={(versionId) => selectVersion.mutate(versionId)}
      usingId={selectVersion.isPending ? selectVersion.variables : null}
    />
  );
};

// The fallback is what the list most often resolves to, so nothing moves when
// it lands: the record button, then one h-8 row under the video and nothing
// more in the prompt editor (a lone selected reading renders no list).
export const ShotDialogueReadings: React.FC<ReadingsProps> = (props) => (
  <Suspense
    fallback={
      <>
        <Skeleton className="h-8 w-32" />
        {props.collapsible ? <Skeleton className="h-8 w-full" /> : null}
      </>
    }
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
          lines={shot.dialogue?.presence ? shot.dialogue.lines : []}
        />
      }
    />
  );
};

/**
 * A shot's lines, editable in place (#1773). The save appends a `user-edit`
 * version of this shot's lines only — no prompt row, no other shot.
 */
export const ShotDialogueLines: React.FC<{
  sequenceId: string;
  shotId: string;
  lines: readonly DialogueLine[];
  label?: string;
}> = ({ sequenceId, shotId, lines, label }) => {
  const queryClient = useQueryClient();
  const { data: characters } = useSequenceCharacters(sequenceId);
  const save = useMutation({
    mutationFn: (next: DialogueLine[]) =>
      saveShotDialogueFn({ data: { sequenceId, shotId, lines: next } }),
    onSuccess: () => invalidateLinesMoved(queryClient, sequenceId, shotId),
    onError: (error: Error) =>
      toast.error('Lines not saved', { description: error.message }),
  });
  return (
    <DialogueLinesEditor
      lines={lines}
      onSave={(next) => save.mutate(next)}
      saving={save.isPending}
      label={label}
      speakers={(characters ?? []).map((character) => character.name)}
    />
  );
};

/**
 * Every shot's lines in one scene, for the Script tab (#1773). Each save
 * writes that shot's lines only; the others stay as they are.
 */
export const SceneDialogueLines: React.FC<{
  sequenceId: string;
  shots: readonly ShotView[];
}> = ({ sequenceId, shots }) => {
  if (shots.length === 0) return null;
  const ordered = [...shots].sort(
    (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
  return (
    <section aria-label="Dialogue" className="flex flex-col gap-2">
      <span className="text-sm font-medium">Dialogue</span>
      <ul className="flex flex-col gap-2">
        {ordered.map((shot, index) => {
          const name = `Shot ${shot.shotNumber ?? index + 1}`;
          return (
            <li
              key={shot.id}
              className="flex flex-col gap-1 rounded-md border p-3"
            >
              <span className="text-xs font-medium">{name}</span>
              <ShotDialogueLines
                sequenceId={sequenceId}
                shotId={shot.id}
                lines={shot.dialogue?.presence ? shot.dialogue.lines : []}
                label={`Edit lines for ${name.toLowerCase()}`}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
};
