/**
 * Shot-list pass (#1486)
 * ============================================================================
 *
 * Scene-split's boundary pass only decides WHERE each scene starts. This
 * module is the second analysis step: given those verbatim slices, cover
 * each scene with 1..N camera setups (from the LLM, or a single default
 * shot when the call fails / omits a scene). Coverage is a director
 * decision — the style's camera / pace / energy — not a script-split.
 *
 * A one-shot scene keeps today's duration (the slice label / estimate). Extra
 * shots take their duration from the spec. Prompts are assembled later by
 * `deriveShots` — this pass does not re-author them.
 */

import type { NewShot } from '@/lib/db/schema';
import { allocateClipDurations } from '@/lib/motion/snap-duration';
import type { StyleConfig } from '@/lib/style/style-config';
import type { DbSceneId } from '@/shared/scene-id';
import type { SceneSplittingScene } from './streaming-scene-parser';
import {
  MAX_SHOTS_PER_SCENE,
  type SceneWithShots,
  type ShotListPassResult,
  type ShotSpec,
} from './shot-list.schema';

/** Fallback shot covering a whole scene when the pass emits nothing. */
export function defaultSingleShot(durationSeconds: number): ShotSpec {
  return {
    shotNumber: 1,
    framing: {
      shotSize: '',
      angle: '',
      composition: '',
      subjectStartState: '',
    },
    action: '',
    cameraMovement: { move: 'static', pacing: 'slow' },
    soundCue: '',
    durationSeconds: durationSeconds > 0 ? durationSeconds : 3,
  };
}

function sceneDurationSeconds(scene: SceneSplittingScene): number {
  return scene.metadata.durationSeconds || 3;
}

/**
 * Sort, re-number 1..n, and cap at MAX_SHOTS_PER_SCENE. Empty / missing → one
 * default shot whose duration is the scene's.
 */
export function normalizeShots(
  shots: ReadonlyArray<ShotSpec> | null | undefined,
  sceneDurationSeconds: number
): ShotSpec[] {
  if (!shots || shots.length === 0) {
    return [defaultSingleShot(sceneDurationSeconds)];
  }
  const ordered = [...shots]
    .sort((a, b) => a.shotNumber - b.shotNumber)
    .slice(0, MAX_SHOTS_PER_SCENE);
  return ordered.map((shot, index) => ({
    ...shot,
    shotNumber: index + 1,
  }));
}

/**
 * Copy each scene and attach a normalized shot list. Unmatched / invalid
 * pass entries fall back to one shot so a degraded LLM result still persists
 * the 1:1 path.
 */
export function attachShotLists(
  scenes: ReadonlyArray<SceneSplittingScene>,
  pass: ShotListPassResult | null | undefined
): SceneSplittingScene[] {
  const byNumber = new Map<number, ShotSpec[]>();
  for (const entry of pass?.scenes ?? []) {
    if (!Number.isFinite(entry.sceneNumber)) continue;
    byNumber.set(entry.sceneNumber, entry.shots);
  }
  return scenes.map((scene, index) => {
    const listed =
      byNumber.get(scene.sceneNumber) ?? byNumber.get(index + 1) ?? null;
    return {
      ...scene,
      shots: normalizeShots(listed, sceneDurationSeconds(scene)),
    };
  });
}

export function isSingleShotScene(
  scene: Pick<SceneSplittingScene, 'shots'>
): boolean {
  return (scene.shots?.length ?? 1) <= 1;
}

/**
 * Rewrite every attached shot's duration so the film sums as close as
 * possible to `targetSeconds` on the video-model clip grid. Scene metadata
 * totals follow the shot sum so the 1-shot persist path (`shotDurationMs`
 * reads scene duration) stays in lockstep.
 *
 * No-op when targetSeconds is missing/non-positive or there are no shots —
 * existing tests and retries without a duration chip stay byte-identical.
 */
export function applyTargetDurations(
  scenes: ReadonlyArray<SceneSplittingScene>,
  targetSeconds: number | undefined,
  grid: readonly number[]
): SceneSplittingScene[] {
  if (targetSeconds == null || !(targetSeconds > 0)) {
    return [...scenes];
  }
  const specs = scenes.flatMap((scene) => scene.shots ?? []);
  if (specs.length === 0) return [...scenes];

  const allocated = allocateClipDurations(
    specs.map((shot) => Math.max(1, shot.durationSeconds || 1)),
    targetSeconds,
    grid
  );
  let i = 0;
  return scenes.map((scene) => {
    const list = scene.shots;
    if (!list || list.length === 0) return scene;
    const nextShots = list.map((shot) => ({
      ...shot,
      durationSeconds: allocated[i++] ?? shot.durationSeconds,
    }));
    const sceneTotal = nextShots.reduce(
      (sum, shot) => sum + shot.durationSeconds,
      0
    );
    return {
      ...scene,
      shots: nextShots,
      metadata: { ...scene.metadata, durationSeconds: sceneTotal },
    };
  });
}

/** Duration written onto `shots.durationMs`: scene label for 1-shot, spec otherwise. */
export function shotDurationMs(
  scene: SceneSplittingScene,
  shot: ShotSpec
): number {
  const shots = scene.shots ?? [shot];
  if (shots.length <= 1) {
    return Math.round(sceneDurationSeconds(scene) * 1000);
  }
  return Math.round((shot.durationSeconds || 3) * 1000);
}

/**
 * `shots` insert rows for a sequence: one per spec, conflict key
 * `(sceneId, shotNumber)`.
 */
export function buildShotInserts(
  sequenceId: string,
  scenes: ReadonlyArray<SceneSplittingScene>,
  sceneIdByOrderIndex: ReadonlyMap<number, DbSceneId | string>
): NewShot[] {
  const inserts: NewShot[] = [];
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index];
    if (!scene) continue;
    const sceneId = sceneIdByOrderIndex.get(index) ?? null;
    const shots =
      scene.shots && scene.shots.length > 0
        ? scene.shots
        : [defaultSingleShot(sceneDurationSeconds(scene))];
    for (const shot of shots) {
      inserts.push({
        sequenceId,
        sceneId,
        shotNumber: shot.shotNumber,
        durationMs: shotDurationMs({ ...scene, shots }, shot),
      });
    }
  }
  return inserts;
}

/** Director brief for the shot-list pass: motion + mood, not the still look. */
export function formatDirectorStyleForShotList(
  style: StyleConfig | null | undefined
): string {
  if (!style) return '';
  const lines = [`Mood: ${style.look.mood}`, `Camera: ${style.motion.camera}`];
  if (style.motion.shots) lines.push(`Shot selection: ${style.motion.shots}`);
  if (style.motion.pace) lines.push(`Pace: ${style.motion.pace}`);
  if (style.motion.energy !== undefined) {
    lines.push(`Energy: ${style.motion.energy}/5`);
  }
  if (style.references.length > 0) {
    lines.push(`References: ${style.references.slice(0, 4).join('; ')}`);
  }
  return lines.join('\n');
}

/** User-prompt body: numbered slices the model must not re-author. */
export function formatScenesForShotListPrompt(
  scenes: ReadonlyArray<
    Pick<SceneSplittingScene, 'sceneNumber' | 'metadata' | 'originalScript'>
  >
): string {
  return scenes
    .map((scene) => {
      const title = scene.metadata.title || `Scene ${scene.sceneNumber}`;
      const lines = [`## Scene ${scene.sceneNumber} — ${title}`];
      if (scene.metadata.location) lines.push(scene.metadata.location);
      if (scene.metadata.durationSeconds) {
        lines.push(`duration: ${scene.metadata.durationSeconds}s`);
      }
      return `${lines.join('\n')}\n\n${scene.originalScript.extract.trim()}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Lift a split scene + its attached specs into the derive.ts input shape.
 * `continuousFromPrevious` is not produced by the boundary pass — false.
 */
export function buildSceneWithShots(
  scene: SceneSplittingScene,
  shots: ReadonlyArray<ShotSpec> = scene.shots ?? []
): SceneWithShots {
  const list =
    shots.length > 0
      ? [...shots]
      : [defaultSingleShot(sceneDurationSeconds(scene))];
  return {
    sceneId: scene.sceneId,
    sceneNumber: scene.sceneNumber,
    originalScript: scene.originalScript,
    metadata: scene.metadata,
    continuity: {
      characterTags: scene.continuity.characterTags,
      environmentTag: scene.continuity.environmentTag,
      elementTags: scene.continuity.elementTags ?? [],
      colorPalette: scene.continuity.colorPalette,
      lightingSetup: scene.continuity.lightingSetup,
      styleTag: scene.continuity.styleTag,
    },
    dialoguePresent: scene.originalScript.dialogue.length > 0,
    continuousFromPrevious: false,
    shots: list,
  };
}
