/**
 * Does this shot animate FROM a rendered still, or straight from references?
 *
 * Sequence sets the default (`referenceOnly`); a shot overrides it
 * (`shots.useStartFrame`, NULL = inherit). One function so every consumer
 * agrees — they drifted before.
 *
 * Not only a render switch: it picks the motion-prompt template
 * (`motion-prompt-workflow`) and folds into the motion hash
 * (`shot-staleness`), so flipping it re-stales the shot's motion prompt.
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
