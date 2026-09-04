/**
 * Shared Motion Prompt Resolution
 *
 * Resolves the motion prompt string for a shot, applying model-specific
 * assembly to the structured motion prompt.
 *
 * Single source of truth (#713): the structured motion prompt comes from the
 * shot's *selected* `shot_prompt_versions` row (reconstructed via
 * `motionPromptFromVersion`), never from `metadata.prompts.motion` (that field
 * was removed from the Scene type). `shot.motionPrompt` is the cached mirror of
 * that selected version's `text`, so a user edit is just the latest version —
 * there is no separate "user override" branch any more.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type { ImageToVideoModel } from '@/lib/ai/models';
import { assembleMotionPrompt } from './assemble-motion-prompt';

/** The `shot_prompt_versions` motion-row fields needed to rebuild a prompt. */
type MotionVersionRow = {
  text: string;
  dialogue: AssemblableMotionPrompt['dialogue'];
  audio: AssemblableMotionPrompt['audio'];
};

/**
 * Reconstruct the assemblable motion prompt from a selected motion
 * `shot_prompt_versions` row. Only `text` (→ `fullPrompt`) plus the
 * dialogue/audio direction feed model-specific assembly; `components` /
 * `parameters` are stored for history but unused at render time.
 */
export function motionPromptFromVersion(
  version: MotionVersionRow
): AssemblableMotionPrompt {
  return {
    fullPrompt: version.text,
    dialogue: version.dialogue,
    audio: version.audio,
  };
}

type ResolveMotionPromptInput = {
  /**
   * The shot's selected motion prompt (reconstructed from its version row), or
   * null when the shot has no motion prompt yet.
   */
  motionPrompt: AssemblableMotionPrompt | null;
  /**
   * Scene character tags (`continuity.characterTags`) for model-specific
   * in-prompt guards (e.g. Seedance's "Avoid jitter and bent limbs.").
   */
  characterTags?: readonly string[];
  /** Fallback prompt when the shot has no motion prompt version. */
  description: string | null;
  /** See `AssembleOptions.generateAudio`. */
  generateAudio?: boolean;
};

/**
 * Resolve the motion prompt for a shot, formatted for the target video model.
 *
 * - If a structured motion prompt exists, assemble a model-specific prompt
 *   (audio-capable models get dialogue/audio appended).
 * - Otherwise fall back to the shot description.
 */
export function resolveMotionPrompt(
  input: ResolveMotionPromptInput,
  model: ImageToVideoModel
): string {
  if (input.motionPrompt) {
    return assembleMotionPrompt({
      motionPrompt: input.motionPrompt,
      model,
      characterTags: input.characterTags,
      generateAudio: input.generateAudio,
    });
  }
  return input.description || '';
}

/**
 * Assemble a shot's motion prompt from its selected version. A shot with no
 * version has no prompt — the scene's script is the last resort.
 */
export function resolveMotionPromptFromVersion(
  version: MotionVersionRow | null | undefined,
  opts: {
    characterTags?: readonly string[];
    description: string | null;
    generateAudio?: boolean;
  },
  model: ImageToVideoModel
): string {
  if (!version) return opts.description || '';
  return resolveMotionPrompt(
    {
      motionPrompt: motionPromptFromVersion(version),
      characterTags: opts.characterTags,
      description: opts.description,
      generateAudio: opts.generateAudio,
    },
    model
  );
}
