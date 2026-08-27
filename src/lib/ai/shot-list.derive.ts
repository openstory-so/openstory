/**
 * Shot-list prompt derivation (#908)
 * ============================================================================
 *
 * Single source of truth: a shot's start-frame visual prompt and motion prompt
 * are ASSEMBLED from the parent scene's shared context plus the shot's own
 * structured fields — never re-authored per shot by the LLM. Keeping the
 * derivation here (one place) is the structural fix for adjacent-clip drift:
 * every shot in a scene inherits the same location / lighting / cast / palette
 * / style truth verbatim.
 *
 *   start-frame visual prompt = scene context + shot framing/start-state
 *   motion prompt             = shot action + camera movement + sound cue
 *
 * The derived shapes are the existing `VisualPrompt` / `MotionPrompt` types so
 * downstream image/motion workflows consume them unchanged. Each shot is
 * persisted as a `Scene` row (shots.metadata is `$type<Scene>()`); the
 * scene-level shared fields are persisted separately to the `scenes` table.
 */

import type { StyleConfig } from '@/lib/db/schema/libraries';
import type { MotionPrompt, VisualPrompt } from './scene-analysis.schema';
import type { SceneWithShots, ShotSpec } from './shot-list.schema';

/** Join non-empty parts with a separator, dropping blanks. */
function joinParts(parts: ReadonlyArray<string>, sep = ', '): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(sep);
}

/**
 * Scene-level shared truth, stated once and reused by every shot's derived
 * prompt. Pulled from the scene's `continuity` + `metadata` + the style config
 * so the LLM never re-derives it per shot.
 */
function sceneContextParts(
  scene: SceneWithShots,
  styleConfig: StyleConfig
): string[] {
  const { continuity, metadata } = scene;
  return [
    metadata.location,
    metadata.timeOfDay,
    continuity.environmentTag,
    continuity.lightingSetup,
    continuity.colorPalette,
    // Cast membership is shared context; the per-shot subject state narrows it.
    continuity.characterTags.join(', '),
    // Style is the single look authored for the whole sequence.
    styleConfig.look.artStyle,
    continuity.styleTag,
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/**
 * Derive the start-frame visual prompt for one shot.
 *
 * fullPrompt = scene context (authored once) + the shot's framing/start-state.
 * Internal building block of `deriveShots` (covered through it).
 */
function deriveVisualPrompt(
  scene: SceneWithShots,
  shot: ShotSpec,
  styleConfig: StyleConfig
): VisualPrompt {
  const { framing } = shot;
  const sceneParts = sceneContextParts(scene, styleConfig);

  const fullPrompt = joinParts([
    framing.shotSize,
    framing.angle,
    framing.subjectStartState,
    framing.composition,
    ...sceneParts,
  ]);

  return { fullPrompt };
}

/**
 * Derive the motion prompt for one shot.
 *
 * fullPrompt = the shot's action + its single camera move (with pacing adverb)
 * + the sound cue. Model-agnostic: no vendor syntax — `assembleMotionPrompt`
 * adapts per model at render time.
 */
export function deriveMotionPrompt(
  scene: SceneWithShots,
  shot: ShotSpec
): MotionPrompt {
  const { action, cameraMovement, soundCue } = shot;
  const cameraPhrase = joinParts(
    [cameraMovement.pacing, cameraMovement.move],
    ' '
  );

  const fullPrompt = joinParts([action, `Camera: ${cameraPhrase}`], '. ');

  // Dialogue presence is a scene-level hint; the start-frame visual carries the
  // performance, the motion prompt carries the move + sound. Lines themselves
  // are sourced from originalScript downstream (audio models), so here we only
  // signal presence and the on-screen sound cue.
  return {
    fullPrompt,
    dialogue: scene.dialoguePresent
      ? {
          presence: true,
          lines: scene.originalScript.dialogue,
        }
      : null,
    audio: soundCue.trim().length
      ? { ambientSound: soundCue, soundEffects: [] }
      : null,
  };
}

/**
 * A derived shot ready to persist: the per-shot `Scene` metadata object plus
 * the shot-level columns (`shotNumber`, `durationMs`) that live on the `shots`
 * table rather than inside the JSON. `shotNumber` stays OUT of the `Scene`
 * metadata — it is a `shots` column (#907).
 *
 * The derived prompts ride alongside (not inside `metadata`): visual/motion
 * prompts persist to `frame_prompt_versions` / `shot_prompt_versions` now, not
 * `scene.prompts` (#713) — the caller writes them through those scoped helpers.
 */
export type DerivedShot = {
  shotNumber: number;
  durationMs: number;
  visualPrompt: VisualPrompt;
  motionPrompt: MotionPrompt;
};

/**
 * Convert one analysis scene into the per-shot rows persisted to the `shots`
 * table: the shot's own duration and derived prompts. Scene context is NOT
 * copied onto the shot — it resolves through `sceneId`.
 *
 * Returned shots are ordered by `shotNumber`. The caller persists each with
 * its `shotNumber` and a `sceneId` linking back to the `scenes` row.
 */
export function deriveShots(
  scene: SceneWithShots,
  styleConfig: StyleConfig
): DerivedShot[] {
  const ordered = [...scene.shots].sort((a, b) => a.shotNumber - b.shotNumber);
  return ordered.map((shot) => {
    const visual = deriveVisualPrompt(scene, shot, styleConfig);
    const motion = deriveMotionPrompt(scene, shot);
    return {
      shotNumber: shot.shotNumber,
      durationMs: Math.round(shot.durationSeconds * 1000),
      visualPrompt: visual,
      motionPrompt: motion,
    };
  });
}
