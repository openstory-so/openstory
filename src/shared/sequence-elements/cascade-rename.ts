/**
 * Cascade an element token rename through every place the old token can be
 * referenced: sequence script text, per-shot metadata (continuity tags,
 * original script extract, prompt strings), the anchor frame's `imagePrompt`
 * and the shot's selected motion prompt version.
 *
 * The rewrite is whole-word and case-insensitive on the haystack side (so a
 * lowercase mention inside script prose is still rewritten), but always emits
 * the new token in its canonical UPPERCASE form. We never touch sub-strings of
 * a longer identifier — renaming `BAR` must not affect `BARBER`.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Shot } from '@/lib/db/schema';

/** Whole-token regex. Boundaries are anything that isn't `[A-Za-z0-9_]`. */
function tokenRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=[^A-Za-z0-9_]|$)`, 'gi');
}

export function replaceTokenInText(
  text: string,
  oldToken: string,
  newToken: string
): string {
  if (!text) return text;
  return text.replace(tokenRegex(oldToken), (_match, prefix: string) => {
    return `${prefix}${newToken}`;
  });
}

function textContainsToken(text: string, token: string): boolean {
  if (!text) return false;
  return tokenRegex(token).test(text);
}

/**
 * Rewrite an element token in a scene's continuity tags. Null when nothing
 * referenced it. The scene's script text is rewritten separately, on its
 * selected `scene_script_versions` row.
 */
export function renameTokenInContinuity(
  continuity: NonNullable<Scene['continuity']>,
  oldToken: string,
  newToken: string
): NonNullable<Scene['continuity']> | null {
  if (oldToken === newToken) return null;
  const oldTags = continuity.elementTags ?? [];
  const newTags = oldTags.map((tag) =>
    tag.toUpperCase() === oldToken.toUpperCase() ? newToken : tag
  );
  if (!newTags.some((t, i) => t !== oldTags[i])) return null;
  return { ...continuity, elementTags: newTags };
}

export type ShotRenameDelta = {
  shotId: string;
  imagePrompt?: string;
  motionPrompt?: string;
};

/**
 * Compute per-shot deltas for a token rename. Shots with no references return
 * null. Neither prompt lives on the shot row: callers pass each shot augmented
 * with its anchor frame's `imagePrompt` (#989) and its selected motion prompt
 * version's text (#713); the applier routes `delta.imagePrompt` to the frame
 * and `delta.motionPrompt` to that version row.
 */
export function buildShotRenameDeltas(
  shots: ReadonlyArray<
    Shot & { imagePrompt: string | null; motionPrompt: string | null }
  >,
  oldToken: string,
  newToken: string
): ShotRenameDelta[] {
  if (oldToken === newToken) return [];

  const deltas: ShotRenameDelta[] = [];
  for (const shot of shots) {
    const delta: ShotRenameDelta = { shotId: shot.id };
    let touched = false;

    if (shot.imagePrompt && textContainsToken(shot.imagePrompt, oldToken)) {
      delta.imagePrompt = replaceTokenInText(
        shot.imagePrompt,
        oldToken,
        newToken
      );
      touched = true;
    }

    if (shot.motionPrompt && textContainsToken(shot.motionPrompt, oldToken)) {
      delta.motionPrompt = replaceTokenInText(
        shot.motionPrompt,
        oldToken,
        newToken
      );
      touched = true;
    }

    if (touched) deltas.push(delta);
  }
  return deltas;
}
