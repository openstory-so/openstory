/**
 * Every line of the scenes on the canvas, under the sequence player (#1802),
 * with Record and Edit on each. The line of the shot being heard is marked —
 * the player's playhead, or a scene's own dialogue played back on its own
 * (its shots' clips in order).
 */

import type { ShotView } from '@/shots/shot-view';
import { useSequenceCharacters } from '@/cast/ui/use-sequence-characters';
import {
  DialogueLineRows,
  PlayDialogueButton,
  recordableLines,
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

const sceneClips = (shots: readonly ShotView[]) =>
  shots.flatMap((shot) =>
    (shot.audioClips ?? []).map((clip) => ({ shotId: shot.id, url: clip.url }))
  );

export const SequenceDialogueLines: React.FC<{
  sequenceId: string;
  shots: readonly ShotView[];
  scenes: readonly SceneWithScript[] | undefined;
  /** The shot under the sequence player's playhead. */
  playingShotId: string | undefined;
}> = ({ sequenceId, shots, scenes, playingShotId }) => {
  const { data: characters } = useSequenceCharacters(sequenceId);
  const player = useDialoguePlayer();
  const take = useLineTake(sequenceId);
  const save = useSaveShotLines(sequenceId);
  const groups = sceneLines(shots, scenes);
  if (groups.length === 0) return null;

  const activeShotId = player.playingShotId ?? playingShotId;
  const speakers = (characters ?? []).map((character) => character.name);

  return (
    <section aria-label="Dialogue" className="flex flex-col gap-4 pt-2">
      {player.audio}
      {groups.map((group) => (
        <div key={group.sceneId} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{group.title}</span>
            <PlayDialogueButton
              player={player}
              clips={sceneClips(group.shots)}
              label={group.title}
            />
          </div>
          {group.shots.map((shot) => {
            const lines = shot.dialogue?.lines ?? [];
            return (
              <DialogueLineRows
                key={shot.id}
                shotId={shot.id}
                lines={lines}
                active={shot.id === activeShotId}
                speakers={speakers}
                onSave={(next) => save.mutate({ shotId: shot.id, lines: next })}
                saving={save.isPending && save.variables.shotId === shot.id}
                take={take}
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
    </section>
  );
};
