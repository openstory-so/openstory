/**
 * Every line of the scenes on the canvas, under the sequence player (#1802),
 * with Record and Edit on each. The line of the shot being heard is marked —
 * the player's playhead, or a scene's own dialogue played back on its own
 * (its shots' clips in order).
 */

import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import {
  ttsCharacterCount,
  voicedDialogueLines,
  type VoiceCharacter,
} from '@/motion/dialogue-tts';
import { dialogueTakeRuns } from '@/shots/dialogue-take-runs';
import { clipSpeechId } from '@/shots/shot-dialogue';
import { getDialogueSpeechUrlsFn } from '@/shots/shot-dialogue.fn';
import { useQuery } from '@tanstack/react-query';
import type { ShotView } from '@/shots/shot-view';
import { useSequenceCharacters } from '@/cast/ui/use-sequence-characters';
import {
  DialogueLineRows,
  PlayDialogueButton,
  RegenerateSceneDialogueButton,
  recordableLines,
  unclearLines,
  useDialoguePlayer,
  useLineTake,
  useSaveShotLines,
} from './dialogue-lines';
import type { SceneWithScript } from './use-scenes';

type SceneLines = {
  sceneId: string;
  title: string;
  shots: ShotView[];
};

/** Consecutive shots of one scene that say something, in shot order. */
function sceneLines(
  shots: readonly ShotView[],
  scenes: readonly SceneWithScript[] | undefined
): SceneLines[] {
  const groups: SceneLines[] = [];
  for (const shot of shots) {
    if (!shot.dialogue?.presence || shot.dialogue.lines.length === 0) continue;
    const sceneId = shot.sceneId ?? shot.id;
    const last = groups.at(-1);
    if (last?.sceneId === sceneId) {
      last.shots.push(shot);
      continue;
    }
    const index = scenes?.findIndex((s) => s.id === sceneId) ?? -1;
    const scene = scenes?.[index];
    groups.push({
      sceneId,
      title: scene?.title || `Scene ${index + 1}`,
      shots: [shot],
    });
  }
  return groups;
}

const shotByShotClips = (shots: readonly ShotView[]) =>
  shots.flatMap((shot) =>
    (shot.audioClips ?? []).map((clip) => ({
      shotIds: [shot.id],
      url: clip.url,
    }))
  );

const speaks = (shot: ShotView) =>
  Boolean(shot.dialogue?.presence && shot.dialogue.lines.length > 0);

/**
 * The speech a scene plays whole: every shot of it that speaks is cut from
 * this one recording, and all of them are on screen. Undefined when the scene
 * mixes takes, or a shot has no audio yet — it then plays shot by shot.
 */
const oneTakeOf = (
  shown: readonly ShotView[],
  sceneShots: readonly ShotView[]
): string | undefined => {
  const voiced = sceneShots.filter(speaks);
  if (voiced.length === 0 || shown.length !== voiced.length) return undefined;
  const ids = new Set(
    voiced.map((shot) => {
      const clip = shot.audioClips?.[0];
      return clip ? clipSpeechId(clip) : undefined;
    })
  );
  const [only] = ids;
  return ids.size === 1 ? only : undefined;
};

/**
 * What regenerating a scene costs: the server records the scene's whole
 * conversation in one call and reserves exactly this (`regenerateShotDialogueFn`).
 */
const sceneRecordingCost = (
  sceneShots: readonly ShotView[],
  characters: readonly VoiceCharacter[]
) =>
  estimateTtsCost(
    ttsCharacterCount(
      sceneShots.flatMap((shot) =>
        voicedDialogueLines(shot.dialogue, characters)
      )
    )
  );

export const SequenceDialogueLines: React.FC<{
  sequenceId: string;
  shots: readonly ShotView[];
  /** Every shot of the sequence: a scene records whole, seen or not. */
  sequenceShots: readonly ShotView[];
  scenes: readonly SceneWithScript[] | undefined;
  /** The shot under the sequence player's playhead. */
  playingShotId: string | undefined;
  /** A line was clicked: go to its shot. */
  onSelectShot?: (shotId: string) => void;
  /** A scene title was clicked: go to the scene. */
  onSelectScene?: (sceneId: string) => void;
}> = ({
  sequenceId,
  shots,
  sequenceShots,
  scenes,
  playingShotId,
  onSelectShot,
  onSelectScene,
}) => {
  const { data: characters } = useSequenceCharacters(sequenceId);
  const player = useDialoguePlayer();
  const take = useLineTake(sequenceId);
  const save = useSaveShotLines(sequenceId);
  const groups = sceneLines(shots, scenes);
  const sceneShotsOf = (sceneId: string) =>
    sequenceShots.filter((shot) => shot.sceneId === sceneId && !shot.deletedAt);
  const oneTakeBySceneId = new Map(
    groups.flatMap((group) => {
      const speechId = oneTakeOf(group.shots, sceneShotsOf(group.sceneId));
      return speechId ? [[group.sceneId, speechId] as const] : [];
    })
  );
  const speechIds = [...new Set(oneTakeBySceneId.values())].sort();
  const { data: speechUrls } = useQuery({
    queryKey: ['dialogue-speech-urls', sequenceId, ...speechIds],
    queryFn: () => getDialogueSpeechUrlsFn({ data: { sequenceId, speechIds } }),
    enabled: speechIds.length > 0,
    staleTime: Infinity,
  });
  if (groups.length === 0) return null;

  const sceneClips = (group: SceneLines) => {
    const speechId = oneTakeBySceneId.get(group.sceneId);
    const url = speechId ? speechUrls?.[speechId] : undefined;
    return url
      ? [{ shotIds: group.shots.map((shot) => shot.id), url }]
      : shotByShotClips(group.shots);
  };
  const listening = player.audio !== null;
  const speakers = (characters ?? []).map((character) => character.name);

  return (
    <section aria-label="Dialogue" className="flex flex-col gap-4 pt-2">
      {player.audio}
      {groups.map((group) => {
        // A shot with no scene groups under its own id; it has no scene to
        // open or record as one.
        const isScene = group.sceneId !== group.shots[0]?.id;
        return (
          <div key={group.sceneId} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              {onSelectScene && isScene ? (
                <button
                  type="button"
                  className="rounded-sm text-left text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => onSelectScene(group.sceneId)}
                >
                  {group.title}
                </button>
              ) : (
                <span className="text-sm font-medium">{group.title}</span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                {isScene ? (
                  <RegenerateSceneDialogueButton
                    sequenceId={sequenceId}
                    shotIds={group.shots.map((shot) => shot.id)}
                    label={group.title}
                    estimate={
                      characters
                        ? sceneRecordingCost(
                            sequenceShots.filter(
                              (shot) =>
                                shot.sceneId === group.sceneId &&
                                !shot.deletedAt
                            ),
                            characters
                          )
                        : undefined
                    }
                  />
                ) : null}
                <PlayDialogueButton
                  player={player}
                  clips={sceneClips(group)}
                  label={group.title}
                />
              </div>
            </div>
            {dialogueTakeRuns(group.shots).map((run) => (
              <div
                key={run.shots[0]?.id}
                className="flex flex-col gap-1 border-l-2 pl-2"
              >
                <span className="text-xs text-muted-foreground">
                  {run.label}
                </span>
                {run.shots.map((shot) => {
                  const lines = shot.dialogue?.lines ?? [];
                  return (
                    <DialogueLineRows
                      key={shot.id}
                      shotId={shot.id}
                      lines={lines}
                      active={
                        listening
                          ? player.isPlaying(shot.id)
                          : shot.id === playingShotId
                      }
                      speakers={speakers}
                      onSave={(next) =>
                        save.mutate({ shotId: shot.id, lines: next })
                      }
                      saving={
                        save.isPending && save.variables.shotId === shot.id
                      }
                      take={take}
                      unclear={unclearLines(shot.audioClips)}
                      onSelect={
                        onSelectShot ? () => onSelectShot(shot.id) : undefined
                      }
                      recordable={recordableLines(
                        lines,
                        shot.audioClips,
                        characters ?? []
                      )}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
};
