/**
 * Free sketches (#2390): an organization with no funds and no key gets
 * {@link FREE_SEQUENCE_LIMIT} sequences up to the dialogue cut, on our models.
 * See `docs/architecture/free-sketches.md`.
 */

import {
  TURBO_DEFAULT_ANALYSIS,
  TURBO_DEFAULT_IMAGE,
} from '@/models/generation-mode';
import { type GenerationStage, stageIndex } from '@/sequences/pipeline';

export const FREE_SEQUENCE_LIMIT = 3;
export const FREE_SCRIPT_MAX_CHARS = 3000;
export const FREE_STOP_AT: GenerationStage = 'dialogue';
export const FREE_ANALYSIS_MODEL = TURBO_DEFAULT_ANALYSIS;
export const FREE_IMAGE_MODEL = TURBO_DEFAULT_IMAGE;

/** Why this run cannot be a free sketch, or null when it can. */
export function freeSketchRefusal(run: {
  stopAt: GenerationStage;
  generateStartFrames: boolean;
  script: string;
}): string | null {
  if (stageIndex(run.stopAt) > stageIndex(FREE_STOP_AT)) {
    return 'Free sketches stop at dialogue. Add credits to render video or music.';
  }
  if (run.generateStartFrames) {
    return 'Free sketches have no start frames. Add credits to turn them on.';
  }
  if (run.script.length > FREE_SCRIPT_MAX_CHARS) {
    return `Free sketches take a script up to ${FREE_SCRIPT_MAX_CHARS.toLocaleString('en')} characters. Shorten it or add credits.`;
  }
  return null;
}
