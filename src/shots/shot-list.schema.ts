/**
 * Shot-list analysis schema (#908)
 * ============================================================================
 *
 * Stage 2 of the Scene / Shot / Frame milestone. Scene analysis stops emitting
 * shot-sized "scenes" and instead emits **scenes containing 1..N shots**, each
 * with a STRUCTURED shot prompt. The split is decided here — during analysis,
 * where the script, dialogue and pacing context live — not downstream in the
 * motion-prompt step.
 *
 * ## Why a separate schema (union budget isolation)
 *
 * Anthropic's strict structured-output grammar caps a request at 16
 * union-typed parameters, and `convertSchemaToJsonSchema` compiles every
 * `.optional()` / `.catch()` / `.nullish()` field into a `["T","null"]` union
 * (an `anyOf` in the emitted JSON Schema). The scene-split schemas already
 * carry optionals; nesting a rich shots[] array inside them would blow that
 * budget. This schema is authored
 * SEPARATELY and kept STRICTLY union-free — every field is required and
 * emptyable by convention ('' / [] / sensible scalar), with no Zod `.default()`,
 * so the model emits the empty value explicitly rather than the parser filling
 * it. The union-budget block in `shot-list.schema.test.ts` asserts the compiled
 * grammar stays at zero `anyOf` so the budget can never be silently exceeded.
 *
 * ## Single source of truth (derive, don't double-author)
 *
 * Scene-level shared truth (location, lighting, cast, palette, style) is stated
 * ONCE per scene by the LLM and reused across every shot. The start-frame
 * visual prompt and the motion prompt are ASSEMBLED from scene context + the
 * shot's own structured fields (see `shot-list.derive.ts`) — never re-derived
 * per shot by the model. This is the structural fix for adjacent-clip drift.
 *
 * ## Model-agnostic
 *
 * The analysis annotates a shot list with framing, one action, exactly one
 * camera move (paired with a pacing adverb), a sound cue, the lines spoken
 * in the shot (#1585) and a duration. It
 * never emits vendor-specific syntax (Seedance/Kling/etc.) — the render layer
 * (#910 / #953) adapts per model capability.
 *
 * ## Live LLM contract (#1486)
 *
 * Scene-split keeps the #1035 boundary-annotation pass (WHERE each scene
 * starts). A second pass then lists shots inside each resolved slice. That
 * second pass sends `shotListPassResultSchema` — sceneNumber + shots[] only,
 * union-free. `sceneWithShotsResultSchema` re-emits script/bibles/continuity
 * and is the assembled (non-LLM) shape; it is not sent as structured output.
 */

import { z } from 'zod';
import {
  characterBibleEntrySchema,
  elementBibleEntrySchema,
  locationBibleEntrySchema,
  originalScriptSchema,
  projectMetadataSchema,
  sceneMetadataSchema,
} from './scene-analysis.schema';

// There are no shot-count or clip-length constants here (#1593): a scene's
// length is its script label and its shots divide it. The prompt budget is
// `minShotsForScene`..`maxShotsForScene` (floor = longest clip, cap =
// shortest); `allocateSceneShots` applies that after parse.

// ============================================================================
// Scene-level shared continuity (strict, union-free)
// ============================================================================
//
// The shared `continuitySchema` marks `elementTags` `.nullish()` (one union).
// The shot-list pass keeps the budget at ZERO, so it declares its own
// continuity with a REQUIRED `elementTags` array (empty when none) instead.
// The inferred shape stays assignable to `Continuity` (empty `string[]` ⊆
// `string[] | null`), so derived `Scene.continuity` flows downstream unchanged.

const shotListContinuitySchema = z.object({
  characterTags: z.array(z.string()).meta({
    description:
      "Snake_case slug of each character appearing in the scene (e.g. 'GIRL ONE' → 'girl_one'). One entry per character; empty array if none.",
  }),
  environmentTag: z
    .string()
    .meta({ description: 'Location/setting tag for environment consistency' }),
  elementTags: z.array(z.string()).meta({
    description:
      'UPPERCASE tokens for elements referenced in this scene. Empty array when none.',
  }),
  colorPalette: z
    .string()
    .meta({ description: 'Dominant colors for visual continuity' }),
  lightingSetup: z
    .string()
    .meta({ description: 'Lighting configuration shared across the shots' }),
  styleTag: z
    .string()
    .meta({ description: 'Visual style reference for a consistent look' }),
});

// ============================================================================
// Structured shot prompt
// ============================================================================

/**
 * Framing / start-state — what the start frame shows. Feeds the start-frame
 * visual prompt alongside the scene context.
 */
// Descriptions are short labels on purpose: they count toward the Anthropic
// grammar budget, so the vocabulary and rules live in the system prompt
// (`phase/scene-shot-list-chat`), which is not budgeted.
const shotFramingSchema = z.object({
  shotSize: z.string().meta({ description: 'Shot size' }),
  angle: z.string().meta({ description: 'Camera angle' }),
  composition: z.string().meta({ description: 'Frame composition' }),
  subjectStartState: z.string().meta({
    description: 'Subject pose/position/expression at the START of the shot',
  }),
});

/**
 * Camera movement — EXACTLY ONE move, paired with a pacing adverb. Never
 * stacked (no "pan then dolly"). Feeds the motion prompt.
 */
const shotCameraMovementSchema = z.object({
  move: z.string().meta({ description: 'The single camera move' }),
  pacing: z.enum(['slow', 'smooth', 'gradual']),
});

/**
 * A line spoken during the shot (#1585). Dialogue is extracted here, on the
 * shot-list call, because it already holds the sliced script and the cast,
 * and which shot a line is spoken in is a coverage decision. The regex
 * parser in `scene-from-slice.ts` only sees screenplay cues; this sees prose.
 */
const shotDialogueLineSchema = z.object({
  character: z.string().meta({ description: 'Speaker, from the cast list' }),
  line: z.string().meta({ description: 'Spoken words, verbatim' }),
  tone: z.string().meta({ description: 'Delivery, empty if none' }),
});

/**
 * One structured shot. Carries exactly what a real shot-list entry has:
 * framing/start-state, one primary action, one camera move, a sound cue, the
 * lines spoken in it and a duration. Visual + motion prompts are DERIVED from
 * these fields plus the parent scene's shared context (see
 * `shot-list.derive.ts`).
 */
export const shotSpecSchema = z.object({
  shotNumber: z.number().meta({ description: '1-based within the scene' }),
  framing: shotFramingSchema,
  action: z.string().meta({ description: 'The ONE primary action' }),
  cameraMovement: shotCameraMovementSchema,
  soundCue: z.string().meta({ description: 'SFX/ambience, empty if none' }),
  dialogue: z.array(shotDialogueLineSchema).meta({
    description: 'Lines spoken in this shot, in order',
  }),
  durationSeconds: z.number().meta({
    description: 'Relative pacing hint in seconds',
  }),
});

export type ShotSpec = z.infer<typeof shotSpecSchema>;

// ============================================================================
// Scene with shots
// ============================================================================

/**
 * A scene that owns an ordered list of shots. Scene-level context (location,
 * lighting, cast, palette, style — via `continuity` + `metadata`) is authored
 * ONCE here and reused by every shot's derived prompts.
 */
export const sceneWithShotsSchema = z.object({
  sceneId: z
    .string()
    .meta({ description: 'Unique identifier for this scene (required)' }),
  sceneNumber: z
    .number()
    .meta({ description: 'Scene order number starting from 1 (required)' }),
  originalScript: originalScriptSchema.meta({
    description: 'Original (verbatim) script content for this scene',
  }),
  metadata: sceneMetadataSchema.meta({
    description: 'Scene-level metadata (title, location, time of day, beat)',
  }),
  continuity: shotListContinuitySchema.meta({
    description:
      'Scene-level shared truth: cast membership, environment, palette, lighting, style — authored once, reused by every shot',
  }),
  dialoguePresent: z.boolean().meta({
    description:
      'Whether the scene contains spoken dialogue. A model-agnostic hint for the render layer (lip-sync vs silent).',
  }),
  continuousFromPrevious: z.boolean().meta({
    description:
      'Whether this scene continues directly from the previous one without a hard cut (a continuous-transition hint for the render layer). False for the first scene.',
  }),
  // `.min(1)` compiles to JSON-Schema minItems — NOT an `anyOf` union — so
  // the bound is enforced at parse time without touching the zero-union
  // budget (asserted in the union-budget test). Clip lengths are assigned
  // after parse per scene (`allocateSceneShots`); the field is a pacing hint.
  shots: z.array(shotSpecSchema).min(1).meta({
    description:
      'Ordered list of shots. A short scene with no internal cut is a single shot.',
  }),
});

export type SceneWithShots = z.infer<typeof sceneWithShotsSchema>;

// ============================================================================
// Top-level shot-list analysis result
// ============================================================================

/**
 * Assembled (non-LLM) shot-list result: scenes with shared continuity plus
 * bibles. Exceeds the Anthropic grammar budget — do not send as
 * `responseSchema`. The live LLM contract is `shotListPassResultSchema`.
 */
export const sceneWithShotsResultSchema = z.object({
  projectMetadata: projectMetadataSchema.meta({
    description: 'Project-level metadata extracted from the script',
  }),
  scenes: z.array(sceneWithShotsSchema).meta({
    description: 'Array of scenes, each owning an ordered list of shots',
  }),
  characterBible: z.array(characterBibleEntrySchema).meta({
    description: 'Character descriptions for visual consistency',
  }),
  locationBible: z.array(locationBibleEntrySchema).meta({
    description: 'Location descriptions for visual consistency',
  }),
  elementBible: z.array(elementBibleEntrySchema).meta({
    description:
      'Elements referenced by UPPERCASE token (uploaded or detected recurring products/objects)',
  }),
});

/**
 * Assembled shot-list analysis result (not the LLM wire shape).
 * @public
 */
export type SceneWithShotsResult = z.infer<typeof sceneWithShotsResultSchema>;

// ============================================================================
// LLM shot-list pass (#1486) — shots inside already-sliced scenes
// ============================================================================

/**
 * One scene's shot list as returned by the second analysis pass. `sceneNumber`
 * matches the already-assembled scene; the pass cannot create or merge scenes.
 */
// The per-scene shot budget is prompt + post-parse (each scene's `shots:`
// line, then `allocateSceneShots`): Anthropic rejects maxItems, so it is not
// on the schema.
export const shotListPassSceneSchema = z.object({
  sceneNumber: z.number().meta({
    description: 'Matches the "## Scene N" heading',
  }),
  shots: z.array(shotSpecSchema).min(1).meta({
    description: "Shots in story order, within the scene's shots: budget",
  }),
});

/**
 * Structured output of the shot-list pass. Union-free and under the Anthropic
 * grammar budget — scene metadata, script text, and bibles are NOT re-emitted.
 */
export const shotListPassResultSchema = z.object({
  scenes: z.array(shotListPassSceneSchema).meta({
    description: 'One entry per input scene, in order',
  }),
});

export type ShotListPassResult = z.infer<typeof shotListPassResultSchema>;
