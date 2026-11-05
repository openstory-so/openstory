/**
 * Re-point one sequence's mentions of a cast character onto another (#2249).
 * Pure. The loser's link cannot move onto the winner while the winner's
 * link exists, so the text, tags and speakers move instead.
 */

import { canonicalBibleTag } from '@/cast/bible-field';
import { normalizeCastName, oneEditApart } from '@/cast/near-name';
import { matchCharacterToShotTags } from '@/shots/scene-matching';
import {
  canonicalStoredShotSpec,
  type StoredShotSpec,
} from '@/shots/shot-list.schema';

export type CastMention = {
  name: string;
  /** Script id on `sequence_cast`, e.g. `char_001`. */
  scriptCharacterId: string;
  consistencyTag: string | null;
};

const mentionOf = (mention: CastMention) => ({
  name: mention.name,
  characterId: mention.scriptCharacterId,
  consistencyTag: mention.consistencyTag,
});

/** Same word boundary as `replaceTokenInText`. Emits the new token in the case of the match. */
function replaceMention(
  text: string,
  oldToken: string,
  newToken: string
): string {
  if (
    !oldToken ||
    normalizeCastName(oldToken) === normalizeCastName(newToken)
  ) {
    return text;
  }
  const escaped = oldToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])(${escaped})(?=[^A-Za-z0-9_]|$)`,
    'gi'
  );
  return text.replace(pattern, (_match, prefix: string, found: string) => {
    const cased =
      found === found.toUpperCase()
        ? newToken.toUpperCase()
        : found === found.toLowerCase()
          ? newToken.toLowerCase()
          : newToken;
    return `${prefix}${cased}`;
  });
}

/** Script id, then a tag that is not the name, then the display name. Longer tokens first. */
export function repointMentionText(
  text: string,
  from: CastMention,
  into: CastMention
): string {
  if (!text) return text;
  const intoTag = canonicalBibleTag({
    name: into.name,
    consistencyTag: into.consistencyTag,
  });
  const fromTag = from.consistencyTag
    ? canonicalBibleTag({
        name: from.name,
        consistencyTag: from.consistencyTag,
      })
    : '';
  const swaps: [string, string][] = [];
  if (
    from.scriptCharacterId &&
    from.scriptCharacterId !== into.scriptCharacterId
  ) {
    swaps.push([from.scriptCharacterId, into.scriptCharacterId]);
  }
  if (
    fromTag &&
    fromTag !== intoTag &&
    normalizeCastName(fromTag) !== normalizeCastName(from.name)
  ) {
    swaps.push([fromTag, intoTag]);
  }
  if (
    from.name &&
    normalizeCastName(from.name) !== normalizeCastName(into.name)
  ) {
    swaps.push([from.name, into.name]);
  }
  swaps.sort((a, b) => b[0].length - a[0].length);
  let next = text;
  for (const [oldToken, newToken] of swaps) {
    next = replaceMention(next, oldToken, newToken);
  }
  return next;
}

/** A speaker cue that names the loser, spelled as the winner. */
export function repointSpeaker(
  speaker: string,
  from: CastMention,
  into: CastMention
): string {
  const cue = speaker.trim();
  if (!cue) return speaker;
  if (normalizeCastName(cue) === normalizeCastName(into.name)) return speaker;
  const namesLoser =
    normalizeCastName(cue) === normalizeCastName(from.name) ||
    oneEditApart(cue, from.name) ||
    cue === from.scriptCharacterId ||
    (from.consistencyTag !== null && cue === from.consistencyTag);
  return namesLoser ? into.name : speaker;
}

export function repointCharacterTags(
  tags: readonly string[],
  from: CastMention,
  into: CastMention
): string[] {
  const intoTag = canonicalBibleTag({
    name: into.name,
    consistencyTag: into.consistencyTag,
  });
  const next: string[] = [];
  for (const tag of tags) {
    const loser = matchCharacterToShotTags(mentionOf(from), [tag]);
    const winner = matchCharacterToShotTags(mentionOf(into), [tag]);
    const rewritten = loser && !winner ? intoTag : tag;
    if (!next.includes(rewritten)) next.push(rewritten);
  }
  return next;
}

/**
 * Drop the loser's look pick. A look id belongs to one character, so it is
 * never copied onto the winner. The winner's own pick stays.
 */
export function repointLookPicks(
  picks: Readonly<Record<string, string>> | null | undefined,
  from: CastMention,
  into: CastMention
): Record<string, string> | undefined {
  if (!picks) return undefined;
  const next: Record<string, string> = {};
  for (const [tag, lookId] of Object.entries(picks)) {
    const loser = matchCharacterToShotTags(mentionOf(from), [tag]);
    const winner = matchCharacterToShotTags(mentionOf(into), [tag]);
    if (loser && !winner) continue;
    next[tag] = lookId;
  }
  return next;
}

export function repointSpec(
  spec: StoredShotSpec,
  from: CastMention,
  into: CastMention
): StoredShotSpec {
  const text = (value: string) => repointMentionText(value, from, into);
  return canonicalStoredShotSpec({
    framing: {
      shotSize: text(spec.framing.shotSize),
      angle: text(spec.framing.angle),
      composition: text(spec.framing.composition),
      subjectStartState: text(spec.framing.subjectStartState),
    },
    action: text(spec.action),
    cameraMovement: {
      move: text(spec.cameraMovement.move),
      pacing: text(spec.cameraMovement.pacing),
    },
    direction: text(spec.direction),
    soundCue: text(spec.soundCue),
  });
}
