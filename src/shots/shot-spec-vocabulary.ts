/**
 * The shot-list vocabulary (#1929): what `phase/scene-shot-list-chat` asks the
 * model to use, and what the spec editor suggests. The test pins the two. Suggestions only — every field
 * is free text, and a move may chain several.
 */

export const SHOT_SIZES = [
  'extreme wide',
  'wide',
  'medium wide',
  'medium',
  'medium close-up',
  'close-up',
  'extreme close-up',
] as const;

export const CAMERA_ANGLES = [
  'eye level',
  'low angle',
  'high angle',
  'overhead',
  'dutch',
  'over-the-shoulder',
] as const;

export const CAMERA_MOVES = [
  'static',
  'pan',
  'tilt',
  'dolly',
  'truck',
  'pedestal',
  'zoom',
  'push-in',
  'pull-out',
  'orbit',
  'arc',
  'follow',
  'handheld drift',
] as const;

export const MOVE_PACINGS = ['slow', 'smooth', 'steady', 'fast'] as const;
