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
} from '@/shots/scene-analysis.schema';
import {
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/models/models';
import {
  DIALOGUE_CLIP_TOKEN,
  isElementVoiceToken,
} from '@/motion/dialogue-tts';

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
  /**
   * The scene editor's "Include SFX & dialogue" toggle. Models with a
   * `generate_audio` request field get it there; H3 Max has no field and
   * always renders an audio track, so `false` is written into its prompt.
   */
  generateAudio?: boolean;
  /**
   * Pin a one-take clip. Seedance otherwise invents cuts; Omni Flash
   * otherwise defaults to multi-shot. Packed in-clip renders pass `false`
   * (#1510). Default true so existing 1-shot callers stay byte-identical.
   */
  singleTake?: boolean;
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
  generateAudio,
  singleTake = true,
}: AssembleOptions): string {
  const { dialogue, audio, fullPrompt } = motionPrompt;
  const supportsAudio = videoModelSupportsAudio(model);
  const vendor = IMAGE_TO_VIDEO_MODELS[model].vendor;

  let assembled: string;

  // Non-audio models: fullPrompt is already great, no enrichment needed
  if (!supportsAudio) {
    assembled = fullPrompt;
    // Omni Flash defaults to multi-shot; pin a oner only on a 1-shot segment.
    if (singleTake && model === 'gemini_omni_flash') {
      assembled = `${fullPrompt}\n\nSingle unbroken scene.`;
    }
  } else {
    // Audio-capable models: enrich fullPrompt with dialogue + audio sections.
    // Stored rows and UI overrides may still be null; the LLM schema uses
    // emptyable objects. Normalize null → undefined for the builders.
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
          characterTags,
          singleTake
        );
        break;
      case 'MiniMax':
        assembled = buildMinimaxH3Prompt(
          fullPrompt,
          dialogueData,
          audioData,
          generateAudio
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

/** One shot inside a packed in-clip generation (#1510). */
export type PackedMotionPromptShot = {
  durationSeconds: number;
  motionPrompt?: AssemblableMotionPrompt;
  /** Fallback when no structured prompt was snapshotted (manual paths). */
  prompt?: string;
  characterTags?: readonly string[];
  generateAudio?: boolean;
};

type KlingMultiPromptElement = {
  prompt: string;
  duration: string;
};

export type PackedMotionPrompt = {
  prompt: string;
  /** Kling only: structured `multi_prompt[]`. Absent on other vendors. */
  multiPrompt?: KlingMultiPromptElement[];
};

/**
 * Assemble one generation covering several shots of a scene. Per-shot bodies
 * come from {@link assembleMotionPrompt}; this only adds vendor cut syntax
 * and timings. A 1-shot list is the existing single-take path.
 */
export function assemblePackedMotionPrompt({
  shots,
  model,
  generateAudio,
}: {
  shots: readonly PackedMotionPromptShot[];
  model: ImageToVideoModel;
  generateAudio?: boolean;
}): PackedMotionPrompt {
  const first = shots[0];
  if (!first) return { prompt: '' };
  if (shots.length === 1) {
    return {
      prompt: assembleOnePackedShot(first, model, generateAudio, true),
    };
  }

  const bodies = shots.map((shot) =>
    assembleOnePackedShot(shot, model, generateAudio, false)
  );
  if (model === 'kling_v3_pro') {
    return {
      prompt: bodies.join('\ncut to\n'),
      multiPrompt: shots.map((shot, i) => ({
        prompt: bodies[i] ?? '',
        duration: klingMultiPromptDuration(shot.durationSeconds),
      })),
    };
  }

  return { prompt: formatPackedShotList(model, shots, bodies) };
}

function assembleOnePackedShot(
  shot: PackedMotionPromptShot,
  model: ImageToVideoModel,
  generateAudio: boolean | undefined,
  singleTake: boolean
): string {
  if (shot.motionPrompt) {
    return assembleMotionPrompt({
      motionPrompt: shot.motionPrompt,
      model,
      characterTags: shot.characterTags,
      generateAudio: shot.generateAudio ?? generateAudio,
      singleTake,
    });
  }
  const fallback = shot.prompt ?? '';
  if (singleTake && model === 'gemini_omni_flash' && fallback.length > 0) {
    return `${fallback}\n\nSingle unbroken scene.`;
  }
  return fallback;
}

function formatPackedShotList(
  model: ImageToVideoModel,
  shots: readonly PackedMotionPromptShot[],
  bodies: readonly string[]
): string {
  let elapsed = 0;
  const labeled = shots.map((shot, i) => {
    const dur = Math.max(1, Math.round(shot.durationSeconds));
    const start = elapsed;
    const end = elapsed + dur;
    elapsed = end;
    const n = i + 1;
    const body = bodies[i] ?? '';
    if (model === 'seedance_v2_5') {
      return `${start}-${end} seconds: Shot ${n}: ${body}`;
    }
    if (model === 'minimax_h3_max') {
      return `Shot ${n} (${start}-${end}s): ${body}`;
    }
    return `Shot ${n}: ${body}`;
  });

  if (
    model === 'seedance_v2' ||
    model === 'seedance_v2_mini' ||
    model === 'seedance_v2_5' ||
    model === 'gemini_omni_flash'
  ) {
    return labeled.join('\ncut to\n');
  }
  return labeled.join('\n\n');
}

/** Kling `multi_prompt[].duration` is the string enum `'1'`…`'15'`. */
function klingMultiPromptDuration(seconds: number): string {
  const n = Math.min(15, Math.max(1, Math.round(seconds)));
  return String(n);
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
// ByteDance Seedance 2.0 / 2.5: sound as natural prose woven into the prompt
// — no labeled sections. One ambient sentence, SFX tied to on-screen actions,
// dialogue kept concise (lip-sync is weaker than SFX/ambience). Neither
// version has negative_prompt or camera_fixed parameters, so guards go
// in-prompt.
//
// The audio DELIMITERS are ByteDance's own parsing convention, not a style
// choice: `{…}` marks the exact words to speak, `<…>` a discrete sound
// effect, `(…)` music. Sending dialogue in plain double quotes (which is what
// this did until #1559) leaves the model to guess where the line starts and
// ends, and lets narrative words either side leak into the spoken take. Note
// `<>` is spent on sound effects here, so character names must never be
// wrapped in angle brackets — the same symbol cannot mean two things.
// Guides: https://fal.ai/learn/devs/bytedance-seedance2-prompts,
// https://docs.byteplus.com/en/docs/ModelArk/2607689
// ---------------------------------------------------------------------------

function buildSeedancePrompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined,
  characterTags: readonly string[] | undefined,
  singleTake: boolean
): string {
  const parts = [fullPrompt];

  const soundProse: string[] = [];
  if (audio?.ambientSound) soundProse.push(asSentence(audio.ambientSound));
  if (audio && audio.soundEffects.length > 0) {
    // Each effect gets its own `<>`: they are discrete, separately timed
    // sounds, where ambience is one continuous bed and stays prose.
    soundProse.push(
      audio.soundEffects.map((sfx) => `<${sfx.trim()}>`).join(' ')
    );
  }
  if (soundProse.length > 0) parts.push(soundProse.join(' '));

  if (dialogue) {
    parts.push(
      dialogue.lines
        .map((line) => spokenLine(line, `{${line.line}}`, 'voice'))
        .join(' ')
    );
  }

  // Constraint words, which the ByteDance guide asks for at the end of the
  // prompt. Seedance invents edits otherwise, conflicting with
  // one-scene-one-take — omit that pin when the clip is a packed multi-shot.
  const guards = [NO_MUSIC_DIRECTION];
  if (singleTake) {
    guards.push('Single continuous shot, no cuts.');
  }
  // Standard guard from the ByteDance prompt guide for scenes with characters
  if (characterTags && characterTags.length > 0) {
    guards.push('Avoid jitter and bent limbs.');
  }
  parts.push(guards.join(' '));

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// MiniMax H3 Max: the model's native prompt is three labelled sections —
// `integrated_multimodal_description` (with dialogue as `<d>[Lang] …</d>`),
// `overall_soundscape`, and `non_diegetic_music`. fal's prompt expander
// rewrites whatever we send into that shape, so the no-music intent has to be
// explicit or the expander invents a score. `non_diegetic_music: N/A` is the
// documented off value.
// Spec: https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir
// ---------------------------------------------------------------------------

function buildMinimaxH3Prompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined,
  generateAudio: boolean | undefined
): string {
  const parts = [fullPrompt];

  // No API switch: "off" is a silent soundscape and no dialogue lines.
  if (generateAudio === false) {
    parts.push(
      'overall_soundscape: Silent. No dialogue, no sound effects, no music.\nnon_diegetic_music: N/A'
    );
    return parts.join('\n\n');
  }

  if (dialogue) {
    // ponytail: dialogue lines carry no language; assume English until the
    // scene schema records one.
    parts.push(
      dialogue.lines
        .map((line) =>
          spokenLine(line, `<d>[English] ${line.line}</d>`, 'tone')
        )
        .join(' ')
    );
  }

  const soundscape: string[] = [];
  if (audio?.ambientSound) soundscape.push(asSentence(audio.ambientSound));
  if (audio && audio.soundEffects.length > 0)
    soundscape.push(asSentence(audio.soundEffects.join(', ')));
  soundscape.push(NO_MUSIC_DIRECTION);
  parts.push(
    `overall_soundscape: ${soundscape.join(' ')}\nnon_diegetic_music: N/A`
  );

  return parts.join('\n\n');
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * One line of dialogue as ONE speaking event (#1559).
 *
 * With a recording bound, the line names it as the source of the words, voice
 * and delivery in the same sentence that carries the transcript. A separate
 * binding sentence after "X says: {…}" read as a second utterance — two
 * speaking events for one line invite the model to say it twice — and a tone
 * adjective beside a recording asks for a delivery the recording already has.
 *
 * Asking for the words FROM the recording is deliberate: by default a
 * reference clip supplies only timbre, accent, pace and emotion, and "the
 * exception is when the user explicitly asks to reuse the dialogue in the
 * audio" (Seedance 2.5 guide). A file bound to a line IS that line.
 *
 * The token is emitted RAW. `buildReferenceVideoPrompt` substitutes it for the
 * endpoint's tag (`@Audio1`), which is why the reference matchers must scan
 * the ASSEMBLED prompt, not `fullPrompt`: this is the only place it appears.
 */
function spokenLine(
  line: DialogueLine,
  words: string,
  toneNoun: 'voice' | 'tone'
): string {
  const subject = line.character || 'A voice';
  if (
    line.voiceToken === DIALOGUE_CLIP_TOKEN ||
    isElementVoiceToken(line.voiceToken)
  ) {
    return `${subject} speaks this line exactly as recorded in ${line.voiceToken}: ${words}`;
  }
  const tone = line.tone ? ` in a ${line.tone} ${toneNoun}` : '';
  return `${subject} says${tone}: ${words}`;
}

// ---------------------------------------------------------------------------
// Default narrative style (Veo / Sora guides): quotes + Audio: section. No
// catalog model routes here today; it stays the fallback for a new vendor.
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
