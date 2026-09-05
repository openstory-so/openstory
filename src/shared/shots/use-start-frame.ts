/**
 * Does this shot animate FROM a rendered still, or straight from references?
 *
 * Sequence sets the default (`generateStartFrames`, off for a new sequence);
 * a shot overrides it (`shots.useStartFrame`, NULL = inherit). One function so
 * every consumer agrees — they drifted before.
 *
 * Not only a render switch: it picks the motion-prompt template
 * (`motion-prompt-workflow`) and folds into the motion hash
 * (`shot-staleness`), so flipping it re-stales the shot's motion prompt.
 */

export type StartFrameShot = { useStartFrame?: boolean | null | undefined };
export type StartFrameSequence = { generateStartFrames: boolean };

export function usesStartFrame(
  shot: StartFrameShot,
  sequence: StartFrameSequence
): boolean {
  return shot.useStartFrame ?? sequence.generateStartFrames;
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

/**
 * The sequence as THIS shot's prompts see it: the row plus the resolved
 * `referenceOnly` that `ShotPromptContextSequence` requires. The mode picks
 * the motion-prompt template and is folded into the motion hash, so every
 * place that hashes, bails, or triggers must read the same per-shot answer —
 * the row's default alone would stamp one value and verify another (#867).
 */
export function shotPromptSequence<T extends StartFrameSequence>(
  sequence: T,
  shot: StartFrameShot
): T & { referenceOnly: boolean } {
  return { ...sequence, referenceOnly: rendersReferenceOnly(shot, sequence) };
}
