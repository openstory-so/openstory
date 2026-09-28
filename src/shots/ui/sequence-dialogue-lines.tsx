/**
 * Every line of the scenes on the canvas, under the sequence player (#1802).
 * The line of the shot being heard is marked — the player's playhead, or a
 * scene's own dialogue played back on its own (its shots' clips in order).
 * Per shot, not per word: nothing records where a word falls in a clip.
 */

import type { ShotView } from '@/shots/shot-view';
import { Button } from '@/ui/shadcn/button';
import { cn } from '@/ui/utils';
import { Play, Square } from 'lucide-react';
import { useState } from 'react';
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

type Clip = { shotId: string; url: string };

const sceneClips = (shots: readonly ShotView[]): Clip[] =>
  shots.flatMap((shot) =>
    (shot.audioClips ?? []).map((clip) => ({ shotId: shot.id, url: clip.url }))
  );

export const SequenceDialogueLines: React.FC<{
  shots: readonly ShotView[];
  scenes: readonly SceneWithScript[] | undefined;
  /** The shot under the sequence player's playhead. */
  playingShotId: string | undefined;
}> = ({ shots, scenes, playingShotId }) => {
  const [heard, setHeard] = useState<{ clips: Clip[]; index: number } | null>(
    null
  );
  const groups = sceneLines(shots, scenes);
  if (groups.length === 0) return null;

  const clip = heard?.clips[heard.index];
  const activeShotId = clip?.shotId ?? playingShotId;
  const next = () =>
    setHeard((h) =>
      h && h.index + 1 < h.clips.length ? { ...h, index: h.index + 1 } : null
    );

  return (
    <section aria-label="Dialogue" className="flex flex-col gap-4 pt-2">
      {clip ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- the lines it speaks are marked below
        <audio
          key={`${heard?.index}-${clip.url}`}
          src={clip.url}
          autoPlay
          onEnded={next}
          onError={next}
          className="hidden"
        />
      ) : null}
      {groups.map((group) => {
        const clips = sceneClips(group.shots);
        const playingThis =
          clip !== undefined &&
          group.shots.some((shot) => shot.id === clip.shotId);
        return (
          <div key={group.sceneId} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{group.title}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={clips.length === 0}
                aria-label={
                  playingThis
                    ? `Stop dialogue for ${group.title}`
                    : `Play dialogue for ${group.title}`
                }
                onClick={() =>
                  setHeard(playingThis ? null : { clips, index: 0 })
                }
              >
                {playingThis ? <Square /> : <Play />}
                {playingThis ? 'Stop' : 'Play dialogue'}
              </Button>
            </div>
            <ul className="flex flex-col">
              {group.shots.flatMap((shot) =>
                (shot.dialogue?.lines ?? []).map((line, index) => (
                  <li
                    key={`${shot.id}-${index}`}
                    aria-current={shot.id === activeShotId ? 'true' : undefined}
                    className={cn(
                      'rounded-md px-2 py-1 text-sm',
                      shot.id === activeShotId && 'bg-accent'
                    )}
                  >
                    <span className="font-medium">
                      {line.character || 'Narrator'}
                    </span>{' '}
                    <span className="text-muted-foreground">“{line.line}”</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        );
      })}
    </section>
  );
};
