/**
 * Model-Aware Motion Prompt Assembly
 *
 * The LLM generates a rich `fullPrompt` with camera direction, performance,
 * and atmosphere. This module enriches that prompt with model-specific
 * dialogue formatting and audio sections at generation time.
 *
 * Strategy: fullPrompt is always the base. Provider builders ADD to it
 * (dialogue lines, audio sections) rather than rebuilding from components.
 */

import type {
  AssemblableMotionPrompt,
  DialogueLine,
  MotionAudio,
  MotionDialogue,
} from '@/lib/ai/scene-analysis.schema';
import {
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/lib/ai/models';

/**
 * Music is a sequence-level track (`sequences.music*`) the user can mute, swap
 * or regenerate; a score the video model bakes into the clip cannot be removed
 * and fights the real one on playback (#1165). Dialogue and diegetic sound are
 * still wanted, so `generate_audio: false` is the wrong lever — every
 * audio-capable model gets this direction in its audio section instead.
 *
 * Phrasing follows Seedance 2.5's documented negative-audio control, which
 * pairs the exclusion with a whitelist ("No BGM; generate only environmental
 * sounds and action sounds") — dialogue is added to that whitelist since a
 * bare negation risks damping the audio we do want. "no music" rides along
 * for the Google/OpenAI models, which don't share ByteDance's BGM vocabulary.
 * Guides: https://docs.byteplus.com/en/docs/ModelArk/2607689 (2.5),
 * https://docs.byteplus.com/en/docs/ModelArk/2222480 (2.0)
 */
const NO_MUSIC_DIRECTION =
  'No BGM, no music. Generate only dialogue, environmental sounds, and action sounds.';

type AssembleOptions = {
  motionPrompt: AssemblableMotionPrompt;
  model: ImageToVideoModel;
  /**
   * Scene character tags (`continuity.characterTags`). Drives character-only
   * guards for models that need them in-prompt (e.g. Seedance's
   * "Avoid jitter and bent limbs.").
   */
  characterTags?: readonly string[];
};

/**
 * Assemble a model-specific motion prompt from structured data.
 *
 * The LLM's `fullPrompt` provides the rich narrative base. For audio-capable
 * models, we append dialogue lines and audio direction in the format each
 * model handles best. Non-audio models get `fullPrompt` as-is.
 */
export function assembleMotionPrompt({
  motionPrompt,
  model,
  characterTags,
}: AssembleOptions): string {
  const { dialogue, audio, fullPrompt } = motionPrompt;
  const supportsAudio = videoModelSupportsAudio(model);
  const vendor = IMAGE_TO_VIDEO_MODELS[model].vendor;

  let assembled: string;

  // Non-audio models: fullPrompt is already great, no enrichment needed
  if (!supportsAudio) {
    assembled = fullPrompt;
  } else {
    // Audio-capable models: enrich fullPrompt with dialogue + audio sections.
    // dialogue/audio are nullish on the schema (the model emits null when a
    // scene has none — see scene-analysis.schema.ts), so normalize null →
    // undefined for the builders.
    const hasDialogue = dialogue?.presence && dialogue.lines.length > 0;
    const dialogueData = hasDialogue ? dialogue : undefined;
    const audioData = audio ?? undefined;

    switch (vendor) {
      case 'Kling':
        assembled = buildKlingPrompt(fullPrompt, dialogueData, audioData);
        break;
      case 'ByteDance':
        assembled = buildSeedancePrompt(
          fullPrompt,
          dialogueData,
          audioData,
          characterTags
        );
        break;
      case 'Google':
      default:
        assembled = buildVeoPrompt(fullPrompt, dialogueData, audioData);
        break;
    }
  }

  return assembled;
}

// ---------------------------------------------------------------------------
// Kling 3.0: Character labels with tone + temporal markers + ambient sounds
// Guide: https://blog.fal.ai/kling-3-0-prompting-guide/
// ---------------------------------------------------------------------------

function buildKlingPrompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined
): string {
  const parts = [fullPrompt];

  // Append dialogue with Kling-specific character labels and temporal markers
  if (dialogue) {
    parts.push(formatKlingDialogue(dialogue.lines));
  }

  // Ambient sound woven into the prompt (Kling generates audio natively)
  const ambientParts: string[] = [];
  if (audio?.ambientSound) ambientParts.push(audio.ambientSound);
  if (audio && audio.soundEffects.length > 0)
    ambientParts.push(audio.soundEffects.join(', '));
  parts.push(
    ambientParts.length > 0
      ? `Ambient sounds: ${ambientParts.join('. ')}. ${NO_MUSIC_DIRECTION}`
      : NO_MUSIC_DIRECTION
  );

  return parts.join('\n\n');
}

function formatKlingDialogue(lines: DialogueLine[]): string {
  return lines
    .map((line) => {
      const label = line.character || 'Narrator';
      const tone = line.tone ? `, ${line.tone}` : '';
      return `[${label}${tone}]: "${line.line}"`;
    })
    .join('\nImmediately, ');
}

// ---------------------------------------------------------------------------
// ByteDance Seedance 2.0: sound as natural prose woven into the prompt — no
// labeled sections. One ambient sentence, SFX tied to on-screen actions,
// dialogue as `X says "…" in a [tone] voice` (lip-sync is weaker than
// SFX/ambience, so dialogue stays concise). Seedance 2.0 has no
// negative_prompt or camera_fixed parameters, so guards go in-prompt.
// Guide: https://fal.ai/learn/devs/bytedance-seedance2-prompts
// ---------------------------------------------------------------------------

function buildSeedancePrompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined,
  characterTags: readonly string[] | undefined
): string {
  const parts = [fullPrompt];

  const soundProse: string[] = [];
  if (audio?.ambientSound) soundProse.push(asSentence(audio.ambientSound));
  if (audio && audio.soundEffects.length > 0) {
    soundProse.push(asSentence(audio.soundEffects.join(', ')));
  }
  if (soundProse.length > 0) parts.push(soundProse.join(' '));

  if (dialogue) {
    const dialogueProse = dialogue.lines
      .map((line) => {
        const subject = line.character || 'A voice';
        const tone = line.tone ? ` in a ${line.tone} voice` : '';
        return `${subject} says "${line.line}"${tone}.`;
      })
      .join(' ');
    parts.push(dialogueProse);
  }

  // Constraint words, which the ByteDance guide asks for at the end of the
  // prompt. Seedance invents edits otherwise, conflicting with
  // one-scene-one-take.
  const guards = [NO_MUSIC_DIRECTION, 'Single continuous shot, no cuts.'];
  // Standard guard from the ByteDance prompt guide for scenes with characters
  if (characterTags && characterTags.length > 0) {
    guards.push('Avoid jitter and bent limbs.');
  }
  parts.push(guards.join(' '));

  return parts.join('\n\n');
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// ---------------------------------------------------------------------------
// Google Veo 3/3.1 + OpenAI Sora: Natural narrative quotes + Audio: section
// Guide: https://fal.ai/learn/devs/veo3-prompt-guide
// ---------------------------------------------------------------------------

function buildVeoPrompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined
): string {
  const parts = [fullPrompt];

  // Append dialogue as natural narrative with inline quotes
  if (dialogue) {
    const dialogueNarrative = dialogue.lines
      .map((line) => {
        const subject = line.character || 'A voice';
        const tone = line.tone ? ` in a ${line.tone} voice` : '';
        return `${subject} says${tone}, "${line.line}"`;
      })
      .join('. ');
    parts.push(dialogueNarrative + '.');
  }

  // Separate Audio: section (Veo guide recommendation)
  const audioParts: string[] = [];
  if (audio?.ambientSound) audioParts.push(audio.ambientSound);
  if (audio && audio.soundEffects.length > 0)
    audioParts.push(audio.soundEffects.join(', '));
  parts.push(
    audioParts.length > 0
      ? `Audio: ${audioParts.join('. ')}. ${NO_MUSIC_DIRECTION}`
      : `Audio: ${NO_MUSIC_DIRECTION}`
  );

  return parts.join('\n\n');
}
