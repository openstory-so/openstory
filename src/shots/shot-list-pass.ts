/**
 * Shot-list pass (#1486)
 * ============================================================================
 *
 * Scene-split's boundary pass only decides WHERE each scene starts. This
 * module is the second analysis step: given those verbatim slices, cover
 * each scene with 1..N camera setups from the LLM. A scene the call omits
 * fails the pass: it carries the dialogue too. Coverage is a director
 * decision — the style's camera / pace / energy — not a script-split. The
 * same call places every spoken line in the shot it is spoken in (#1585);
 * the scene's `originalScript.dialogue` is rebuilt from those, each line
 * stamped with its shot.
 *
 * Length is per scene (#1593). A scene's running time is its script label
 * (`metadata.durationSeconds`); its shots divide it and never extend it. The
 * LLM decides coverage — how many shots, 1..N — capped at one shot per
 * editorial second, and `allocateClipDurations` spreads the label over them
 * on 1s…max (not the model's shortest clip). Leftover packs under the model
 * floor snap at render. Enhance no longer labels shots (#1621): the
 * shot-list pass is the only place shot count and durations are decided. The
 * film target never enters here. Prompts are assembled later by `deriveShots` —
 * this pass does not re-author them.
 */

import type { NewShot } from '@/platform/server/db/schema';
import { dialogueWordBudget, spokenWordCount } from '@/motion/dialogue-tts';
import { allocateClipDurations } from '@/motion/snap-duration';
import type { StyleConfig } from '@/look/style-config';
import type {
  CharacterBibleEntry,
  DialogueLine,
  Scene,
} from '@/shots/scene-analysis.schema';
import type { DbSceneId } from '@/shots/scene-id';
import type { SceneSplittingScene } from '@/sequences/server/streaming-scene-parser';
import type {
  SceneWithShots,
  ShotListPassResult,
  ShotSpec,
} from './shot-list.schema';

function editorialGrid(grid: readonly number[]): number[] {
  const maxClip = Math.max(...grid.filter((n) => n > 0));
  if (!Number.isFinite(maxClip) || maxClip < 1) return [...grid];
  return Array.from({ length: maxClip }, (_, i) => i + 1);
}

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
    dialogue: [],
    durationSeconds: durationSeconds > 0 ? durationSeconds : 3,
  };
}

function sceneDurationSeconds(
  scene: Pick<SceneSplittingScene, 'metadata'>
): number {
  return scene.metadata.durationSeconds || 3;
}

/** Editorial floor: a shot may be 1s; leftover packs snap to the model min. */
const EDITORIAL_MIN_SECONDS = 1;

/**
 * How many shots a scene can hold: one per editorial second, never fewer
 * than one. The video model's shortest clip is a *render* floor, not a shot
 * floor — packing absorbs inserts under that min. No grid → no cap.
 */
export function maxShotsForScene(
  sceneSeconds: number,
  grid: readonly number[]
): number {
  const hasGrid = grid.some((n) => n > 0);
  if (!hasGrid) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(sceneSeconds / EDITORIAL_MIN_SECONDS));
}

/**
 * How many shots a scene NEEDS: one per longest clip, so the label is
 * reachable without any shot running past the grid. No grid → 1.
 */
export function minShotsForScene(
  sceneSeconds: number,
  grid: readonly number[]
): number {
  const maxClip = Math.max(...grid.filter((n) => n > 0));
  if (!Number.isFinite(maxClip)) return 1;
  return Math.max(1, Math.ceil(sceneSeconds / maxClip));
}

/** First `count` shots; the dialogue of the cut ones moves to the last kept (#1585). */
function keepShots(
  ordered: ReadonlyArray<ShotSpec>,
  count: number
): ShotSpec[] {
  const kept = ordered.slice(0, count);
  const cut = ordered.slice(count);
  const last = kept[kept.length - 1];
  if (cut.length > 0 && last) {
    kept[kept.length - 1] = {
      ...last,
      dialogue: [...last.dialogue, ...cut.flatMap((shot) => shot.dialogue)],
    };
  }
  return kept;
}

/**
 * Split a shot holding more speech than the longest clip can carry into
 * back-to-back shots on the same setup, between lines (#1657). The prompt's
 * placement budget is advice the model can ignore — eleven lines on one 15s
 * shot recorded at 17.1s and failed the run after the audio was paid for.
 * A single line over the budget stays whole: a line is never cut.
 */
function splitOverfullShots(
  ordered: ReadonlyArray<ShotSpec>,
  grid: readonly number[]
): ShotSpec[] {
  const maxClip = Math.max(...grid.filter((n) => n > 0));
  if (!Number.isFinite(maxClip)) return [...ordered];
  const budget = dialogueWordBudget(maxClip);
  const words = (lines: ShotSpec['dialogue']) =>
    spokenWordCount(lines.map((line) => ({ text: line.line })));
  return ordered.flatMap((shot) => {
    const groups: ShotSpec['dialogue'][] = [];
    for (const line of shot.dialogue) {
      const last = groups.at(-1);
      if (last && words([...last, line]) <= budget) last.push(line);
      else groups.push([line]);
    }
    // ponytail: every piece keeps the shot's full pacing weight, so a split
    // take gets a speech-sized share of the label; weight by words if pacing
    // around split shots ever reads wrong.
    return groups.length > 1
      ? groups.map((dialogue) => ({ ...shot, dialogue }))
      : [shot];
  });
}

/**
 * Sort, re-number 1..n, and give every shot its clip length from the SCENE
 * (#1593). Empty / missing → one default shot at the scene's length.
 *
 * A shot with more speech than the longest clip holds is split first
 * (`splitOverfullShots`). The list is capped at `maxShotsForScene` (post-parse only — Anthropic
 * rejects `maxItems`), a lone shot takes the whole label, and several split
 * it with `allocateClipDurations` on 1s…max, the LLM's
 * `durationSeconds` as relative weights. A label the grid cannot reach
 * exactly (a 12s label on a {5, 10} grid) puts the residual on the last
 * shot, and `resolveShotDuration` snaps at submit — but no shot ever runs
 * past the model's longest clip: when the pass sends fewer shots than the
 * label needs (ten for a 16-minute scene), the scene comes up short rather
 * than ending on a 14-minute "clip".
 */
export function allocateSceneShots(
  shots: ReadonlyArray<ShotSpec> | null | undefined,
  scene: Pick<SceneSplittingScene, 'metadata'>,
  grid: readonly number[]
): ShotSpec[] {
  const sceneSeconds = sceneDurationSeconds(scene);
  if (!shots || shots.length === 0) {
    return [defaultSingleShot(sceneSeconds)];
  }
  const ordered = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);
  const kept = keepShots(
    splitOverfullShots(ordered, grid),
    maxShotsForScene(sceneSeconds, grid)
  );
  let seconds: number[];
  if (kept.length === 1) {
    seconds = [sceneSeconds];
  } else {
    seconds = allocateClipDurations(
      kept.map((shot) => Math.max(1, shot.durationSeconds || 1)),
      sceneSeconds,
      editorialGrid(grid)
    );
    const residual = sceneSeconds - seconds.reduce((a, b) => a + b, 0);
    const lastIndex = seconds.length - 1;
    const last = seconds[lastIndex];
    if (residual !== 0 && last !== undefined) {
      seconds[lastIndex] = Math.max(1, last + residual);
    }
  }
  const maxClip = Math.max(...grid.filter((n) => n > 0));
  return kept.map((shot, index) => ({
    ...shot,
    shotNumber: index + 1,
    durationSeconds: Math.min(
      maxClip > 0 ? maxClip : Number.POSITIVE_INFINITY,
      seconds[index] ?? shot.durationSeconds
    ),
  }));
}

/**
 * A scene's dialogue as its shots spell it, in shot order (#1585). Every
 * line is stamped with its shot — a one-shot scene's lines with `1` — so an
 * absent stamp means exactly one thing downstream: a row from before #1585.
 * `dialogueForShot` is the filter.
 */
export function dialogueFromShots(
  shots: ReadonlyArray<ShotSpec>
): DialogueLine[] {
  return shots.flatMap((shot) =>
    shot.dialogue
      .filter((line) => line.line.trim().length > 0)
      .map((line) => ({
        character: line.character.trim(),
        line: line.line.trim(),
        tone: line.tone,
        shotNumber: shot.shotNumber,
      }))
  );
}

/**
 * The lines spoken in one shot: those stamped with its number, plus any with
 * no stamp at all (rows from before #1585, when every clip carried the whole
 * scene). The stamp is stripped on the way out because it is a storage fact:
 * the prompt, its input hash and the stored motion dialogue never see it.
 * Tolerates a missing list: pre-#1030 scene metadata did not always carry
 * one.
 *
 * Stamps follow the shot, not the number: `shots.reorderInScene` rewrites
 * them when it renumbers. A soft-deleted shot keeps its lines (restore is
 * lossless), and a shot added by hand starts with none.
 */
export function dialogueForShot(
  lines: ReadonlyArray<DialogueLine> | undefined,
  shotNumber: number
): DialogueLine[] {
  return (lines ?? [])
    .filter(
      (line) => line.shotNumber === undefined || line.shotNumber === shotNumber
    )
    .map(({ shotNumber: _stamp, ...line }) => line);
}

/**
 * The script a shot is prompted and hashed from: the scene's script with its
 * dialogue narrowed to that shot.
 *
 * `originalScript` is hashed VERBATIM (`sceneInputContext`), so this view is
 * the whole hashed script surface — and the stamp and the verify build it
 * from different rows (an in-memory analysis `Scene` at trigger time, the
 * selected `scene_script_versions` row afterwards). Both go through here so
 * the narrowing cannot drift between them; #1732 is what one stamp site
 * drifting costs. Anything added to this view lands on both sides at once.
 */
export function scriptForShot(
  script: Scene['originalScript'],
  shotNumber: number
): Scene['originalScript'] {
  return { ...script, dialogue: dialogueForShot(script.dialogue, shotNumber) };
}

/**
 * One scene with the pass's shots attached: allocated over its label
 * (`allocateSceneShots` on `grid`), its dialogue rebuilt from them.
 */
export function attachSceneShots(
  scene: SceneSplittingScene,
  listed: ReadonlyArray<ShotSpec>,
  grid: readonly number[]
): SceneSplittingScene {
  const shots = allocateSceneShots(listed, scene, grid);
  return {
    ...scene,
    shots,
    originalScript: {
      ...scene.originalScript,
      dialogue: dialogueFromShots(shots),
    },
  };
}

/**
 * Copy each scene and attach its shot list (`attachSceneShots`). Entries
 * match on `sceneNumber`; when the pass returned exactly one entry per
 * scene they also match by position, so a mis-numbered entry still lands.
 * Throws when the pass omits a scene: the omitted scene would otherwise
 * keep its streamed regex preview — empty for prose — with nothing telling
 * anyone, the degrade #1585 removed.
 */
export function attachShotLists(
  scenes: ReadonlyArray<SceneSplittingScene>,
  pass: ShotListPassResult,
  grid: readonly number[]
): SceneSplittingScene[] {
  const byNumber = new Map<number, ShotSpec[]>();
  for (const entry of pass.scenes) {
    if (!Number.isFinite(entry.sceneNumber)) continue;
    byNumber.set(entry.sceneNumber, entry.shots);
  }
  const positional = pass.scenes.length === scenes.length;
  const listedFor = (scene: SceneSplittingScene, index: number) =>
    byNumber.get(scene.sceneNumber) ??
    (positional ? pass.scenes[index]?.shots : undefined);
  const missing = scenes
    .filter((scene, index) => !listedFor(scene, index))
    .map((scene) => scene.sceneNumber);
  if (missing.length > 0) {
    throw new Error(
      `Shot-list pass covered ${pass.scenes.length}/${scenes.length} scenes; missing scene(s) ${missing.join(', ')}`
    );
  }
  return scenes.map((scene, index) =>
    attachSceneShots(scene, listedFor(scene, index) ?? [], grid)
  );
}

/** Duration written onto `shots.durationMs`: the allocated spec duration. */
export function shotDurationMs(shot: ShotSpec): number {
  return Math.round((shot.durationSeconds || 3) * 1000);
}

/** The shot specs a scene persists: its own, or one shot covering it. */
export function sceneShotSpecs(
  scene: Pick<SceneSplittingScene, 'shots' | 'metadata'>
): ShotSpec[] {
  return scene.shots && scene.shots.length > 0
    ? scene.shots
    : [defaultSingleShot(sceneDurationSeconds(scene))];
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
    for (const shot of sceneShotSpecs(scene)) {
      inserts.push({
        sequenceId,
        sceneId,
        shotNumber: shot.shotNumber,
        durationMs: shotDurationMs(shot),
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

/**
 * Cast list for the shot-list prompt: every bible name, spelled as the rest
 * of the pipeline spells it, with voice-only entries marked so narration and
 * off-screen speech have a speaker to be attributed to (#1585).
 */
export function formatCastForShotList(
  cast: ReadonlyArray<Pick<CharacterBibleEntry, 'name' | 'voiceOnly'>>
): string {
  if (cast.length === 0) return '(none)';
  return cast
    .map((entry) => `- ${entry.name}${entry.voiceOnly ? ' (voice only)' : ''}`)
    .join('\n');
}

/**
 * The `shots:` budget line for one scene (#1593, #1621): the range the
 * scene's label allows — at least one per longest clip, at most one per
 * editorial second. The model's shortest clip is a render floor, not a
 * shot floor. Without the floor the model reads "up to N" as licence for a
 * handful and a long scene ends on one huge shot. The shot-list LLM
 * decides coverage within this range on its own — Enhance no longer locks
 * the count via its own shot labels.
 */
function shotBudgetLine(
  scene: Pick<SceneSplittingScene, 'metadata'>,
  grid: readonly number[]
): string | undefined {
  const seconds = scene.metadata.durationSeconds || 3;
  const cap = maxShotsForScene(seconds, grid);
  if (!Number.isFinite(cap)) return undefined;
  const floor = Math.min(cap, minShotsForScene(seconds, grid));
  if (floor === cap) return `shots: exactly ${cap}`;
  return floor > 1 ? `shots: ${floor} to ${cap}` : `shots: up to ${cap}`;
}

/** User-prompt body: numbered slices the model must not re-author. */
export function formatScenesForShotListPrompt(
  scenes: ReadonlyArray<
    Pick<SceneSplittingScene, 'sceneNumber' | 'metadata' | 'originalScript'>
  >,
  grid: readonly number[]
): string {
  return scenes
    .map((scene) => {
      const title = scene.metadata.title || `Scene ${scene.sceneNumber}`;
      const lines = [`## Scene ${scene.sceneNumber} — ${title}`];
      if (scene.metadata.location) lines.push(scene.metadata.location);
      if (scene.metadata.durationSeconds) {
        lines.push(`duration: ${scene.metadata.durationSeconds}s`);
      }
      const budget = shotBudgetLine(scene, grid);
      if (budget) lines.push(budget);
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
