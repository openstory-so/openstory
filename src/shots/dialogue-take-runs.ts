/**
 * Which recording each shot of a scene plays (#1802), so the dialogue list
 * can show where a scene is one continuous take and where it is stitched
 * from separate ones. Consecutive shots cut from the same speech form a run.
 *
 * The scene's take is the speech most of its shots play (ties: the newest).
 * Every other run is named against it: the user's mic take, an older take,
 * or a newer one made for fewer shots.
 */

import type { MotionAudioClip } from '@/platform/server/db/schema';
import { clipSpeechId } from '@/shots/shot-dialogue';

export type TakeRun<S> = {
  shots: S[];
  /** One-line caption for the run. */
  label: string;
};

export function dialogueTakeRuns<
  S extends { audioClips?: MotionAudioClip[] | null },
>(shots: readonly S[]): TakeRun<S>[] {
  const clipOf = (shot: S) => shot.audioClips?.[0];
  const speechOf = (shot: S) => {
    const clip = clipOf(shot);
    return clip ? clipSpeechId(clip) : undefined;
  };

  const countBySpeech = new Map<string, number>();
  for (const shot of shots) {
    const id = speechOf(shot);
    if (id) countBySpeech.set(id, (countBySpeech.get(id) ?? 0) + 1);
  }
  // ULIDs sort by time, so the newest wins a tie.
  const [sceneTake] = [...countBySpeech].sort(
    ([a, na], [b, nb]) => nb - na || b.localeCompare(a)
  );

  const runs: { speechId: string | undefined; shots: S[] }[] = [];
  for (const shot of shots) {
    const speechId = speechOf(shot);
    const last = runs.at(-1);
    if (last && last.speechId === speechId) last.shots.push(shot);
    else runs.push({ speechId, shots: [shot] });
  }

  return runs.map(({ speechId, shots: runShots }) => {
    const count = speechId ? (countBySpeech.get(speechId) ?? 0) : 0;
    const shotsWord = (n: number) => (n === 1 ? '1 shot' : `${n} shots`);
    const label = !speechId
      ? runShots.some((shot) => clipOf(shot))
        ? 'Earlier audio'
        : 'No audio yet'
      : runShots.some((shot) => clipOf(shot)?.source === 'mic')
        ? 'Your take'
        : speechId === sceneTake?.[0]
          ? `One take · ${shotsWord(count)}`
          : sceneTake && speechId < sceneTake[0]
            ? `Older take · ${shotsWord(count)}`
            : count === 1
              ? 'Regenerated alone'
              : `Newer take · ${shotsWord(count)}`;
    return { shots: runShots, label };
  });
}
