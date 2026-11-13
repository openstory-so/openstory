/**
 * Keyframe lines (#2386): how a shot's timed actions are written into its
 * motion prompt, found again for the highlight, and moved when the shot sits
 * later in a packed clip. One format, so the three cannot drift.
 *
 *   0-4 seconds: she vaults the bonnet
 *   4 seconds to the end: she sprints for the alley
 */

import type { ShotKeyframe } from './shot-list.schema';

const KEYFRAME_LINE =
  /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))? seconds( to the end)?: /;

const seconds = (value: number): string => String(Math.round(value * 10) / 10);

/** One line per keyframe; each runs to the next, the last to the end. */
export function keyframeLines(keyframes: readonly ShotKeyframe[]): string[] {
  return keyframes.map((keyframe, index) => {
    const next = keyframes[index + 1];
    const range = next
      ? `${seconds(keyframe.atSeconds)}-${seconds(next.atSeconds)} seconds`
      : `${seconds(keyframe.atSeconds)} seconds to the end`;
    return `${range}: ${keyframe.action}`;
  });
}

export function isKeyframeLine(line: string): boolean {
  return KEYFRAME_LINE.test(line);
}

/**
 * Re-time a shot's keyframe lines for a clip it does not start: shot-local
 * seconds become clip seconds, and "to the end" becomes the shot's own end.
 */
export function shiftKeyframeLines(
  text: string,
  offsetSeconds: number,
  shotSeconds: number
): string {
  return text
    .split('\n')
    .map((line) => {
      const match = KEYFRAME_LINE.exec(line);
      if (!match) return line;
      const start = Number(match[1]) + offsetSeconds;
      const end =
        match[2] === undefined
          ? offsetSeconds + shotSeconds
          : Number(match[2]) + offsetSeconds;
      return `${seconds(start)}-${seconds(end)} seconds: ${line.slice(match[0].length)}`;
    })
    .join('\n');
}
