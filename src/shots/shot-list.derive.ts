import { sceneDirection } from './scene-direction';
/**
 * Shot-list prompt derivation (#908)
 * ============================================================================
 *
 * Single source of truth: a shot's start-frame visual prompt and motion prompt
 * are ASSEMBLED from the parent scene's shared context plus the shot's spec —
 * never re-authored per shot by the LLM. Analysis calls it today; spec
 * edits and rebuilds will (#1915 part 2). Keeping the derivation here (one
 * place) is the structural fix for adjacent-clip drift:
 * every shot in a scene inherits the same location / lighting / palette
 * / style truth verbatim.
 *
 *   start-frame visual prompt = scene context + shot framing/start-state
 *   motion prompt             = shot action + direction + camera movement
 *                               + sound cue
 *                               (reference-only prefixes unique framing;
 *                               scene lighting/palette/look stay on the scene)
 *
 * Text is derived when a prompt version is written, never at render time: the
 * version stores it and records the `specVersionId` it came from.
 */

import type { StyleConfig } from '@/platform/server/db/schema/libraries';
import type { MotionAudio } from './scene-analysis.schema';
import type { StoredShotSpec } from './shot-list.schema';

/** Join non-empty parts with a separator, dropping blanks. */
function joinParts(parts: ReadonlyArray<string>, sep = ', '): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(sep);
}

/**
 * The scene fields derivation reads: an analysis scene or a D1 scene row.
 * Everything else about the scene reaches the video through the packed
 * header, not through the shot's text.
 */
export type DeriveScene = Parameters<typeof sceneDirection>[0] & {
  continuity?: { environmentTag?: string | null } | null;
};

/**
 * Scene-level shared truth, stated once and reused by every shot's derived
 * prompt, so the LLM never re-derives it per shot.
 */
function sceneContextParts(
  scene: DeriveScene,
  styleConfig: StyleConfig
): string[] {
  const direction = sceneDirection(scene, styleConfig);
  const environmentTag = scene.continuity?.environmentTag ?? '';
  const multipleLocations = environmentTag.includes(',');
  return [
    multipleLocations ? '' : direction.location,
    direction.timeOfDay,
    // A multi-location scene's roster is not a single shot's background.
    multipleLocations ? '' : environmentTag,
    direction.lightingSetup,
    direction.colorPalette,
    // Cast belongs to the shot's framing, not the scene-wide roster. Appending
    // that roster here puts later arrivals and off-camera listeners in every
    // start frame, overriding the shot's framing.subjectStartState.

    // Style is the single look authored for the whole sequence.
    direction.look,
  ];
}

function framingParts(spec: StoredShotSpec): string[] {
  const { framing } = spec;
  return [
    framing.shotSize,
    framing.angle,
    framing.subjectStartState,
    framing.composition,
  ];
}

/** Start-frame text: the shot's framing, then the scene context. */
export function deriveStillPrompt(
  spec: StoredShotSpec,
  scene: DeriveScene,
  styleConfig: StyleConfig
): string {
  return joinParts([
    ...framingParts(spec),
    ...sceneContextParts(scene, styleConfig),
  ]);
}

/**
 * Motion text: action, direction and camera move, plus the sound cue as
 * audio direction. Reference-only has no still, so the opening frame lives
 * in prose — but only the shot's own framing: scene lighting / palette / look
 * attach once at assemble time (#1510 packed header). Model-agnostic: no
 * vendor syntax; `buildMotionShotPrompt` adapts per model at render time.
 */
export function deriveMotionPrompt(
  spec: StoredShotSpec,
  options: { referenceOnly: boolean }
): { text: string; audio: MotionAudio } {
  const { action, direction, cameraMovement, soundCue } = spec;
  const cameraPhrase = joinParts(
    [cameraMovement.pacing, cameraMovement.move],
    ' '
  );
  const motion = joinParts(
    [action, direction, cameraPhrase ? `Camera: ${cameraPhrase}` : ''],
    '. '
  );
  return {
    text: options.referenceOnly
      ? joinParts([joinParts(framingParts(spec)), motion], '. ')
      : motion,
    audio: { ambientSound: soundCue.trim(), soundEffects: [] },
  };
}
