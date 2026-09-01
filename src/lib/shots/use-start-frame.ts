/**
 * Does this shot animate FROM a rendered still, or straight from references?
 *
 * The sequence sets the default (`referenceOnly`); a shot may override it
 * (`shots.useStartFrame`, NULL = inherit). One question, one function, because
 * three places have to give the same answer: the motion panel's checkbox, the
 * eligibility filter that decides a shot can render at all, and the submit
 * path that either passes the still or does not.
 *
 * At render time it changes exactly what `buildReferenceVideoPrompt` does with
 * `startImageUrl`: with a still it prepends "Use @Image1 as the starting
 * frame." and binds references from slot 2; without one it drops that line and
 * binds from slot 1, freeing a slot. The prompt TEXT is the user's either way
 * — this is not a prompt-style switch.
 */

export type StartFrameShot = { useStartFrame?: boolean | null | undefined };
export type StartFrameSequence = { referenceOnly: boolean };

export function usesStartFrame(
  shot: StartFrameShot,
  sequence: StartFrameSequence
): boolean {
  return shot.useStartFrame ?? !sequence.referenceOnly;
}

/**
 * The inverse, in the vocabulary the render path already speaks. Submit,
 * pricing and the prompt builders all key on `referenceOnly`.
 */
export function rendersReferenceOnly(
  shot: StartFrameShot,
  sequence: StartFrameSequence
): boolean {
  return !usesStartFrame(shot, sequence);
}

/**
 * Can the user tick "Use Start Frame" for this shot right now?
 *
 * Only with a still to point at. A reference-only sequence renders none, so
 * the box stays disabled until one is generated — ticking it must never mean
 * "and also go make an image", which would spend money from a checkbox.
 */
export function canUseStartFrame(shot: {
  image?: { url?: string | null } | null;
}): boolean {
  return !!shot.image?.url;
}
