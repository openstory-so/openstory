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
 * camera move (paired with a pacing adverb), a sound cue and a duration. It
 * never emits vendor-specific syntax (Seedance/Kling/etc.) — the render layer
 * (#910) adapts per model capability.
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

// ============================================================================
// Constraints (issue #908)
// ============================================================================

/**
 * Multi-shot render ceiling. A scene must stay renderable as ONE call on a
 * capable model (Seedance 2.0 / Kling 3.0 cap at 15s), so the sum of its shot
 * durations is capped here.
 */
export const MAX_SCENE_DURATION_SECONDS = 15;
/** Floor on an individual shot so a scene can't degenerate into micro-cuts. */
export const MIN_SHOT_DURATION_SECONDS = 3;
/**
 * Derived ceiling on shots per scene: with a 3s floor and a 15s scene cap a
 * scene holds at most 5 shots. Richer shot lists are allowed (more shots =
 * more image credits, documented in the PR), but never beyond what the scene
 * can render as one call.
 */
export const MAX_SHOTS_PER_SCENE = Math.floor(
  MAX_SCENE_DURATION_SECONDS / MIN_SHOT_DURATION_SECONDS
);

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
const shotFramingSchema = z.object({
  shotSize: z.string().meta({
    description:
      'Shot size: extreme wide, wide, medium wide, medium, medium close-up, close-up, extreme close-up',
  }),
  angle: z.string().meta({
    description:
      'Camera angle: eye level, low angle, high angle, overhead, dutch, over-the-shoulder',
  }),
  composition: z.string().meta({
    description:
      'How the frame is composed: rule-of-thirds placement, depth, foreground/background, focal point',
  }),
  subjectStartState: z.string().meta({
    description:
      "The subject's state at the START of the shot: pose, position, expression, what they hold — the still the start frame captures",
  }),
});

/**
 * Camera movement — EXACTLY ONE move, paired with a pacing adverb. Never
 * stacked (no "pan then dolly"). Feeds the motion prompt.
 */
const shotCameraMovementSchema = z.object({
  move: z.string().meta({
    description:
      'The single primary camera move: static, pan, tilt, dolly, truck, pedestal, zoom, push-in, pull-out, orbit. Exactly one — never stacked.',
  }),
  pacing: z.enum(['slow', 'smooth', 'gradual']).meta({
    description:
      'Pacing adverb for the move: slow, smooth, or gradual. Keeps motion calm and avoids the chaotic output fast moves trigger in video models.',
  }),
});

/**
 * One structured shot. Carries exactly what a real shot-list entry has:
 * framing/start-state, one primary action, one camera move, a sound cue and a
 * duration. Visual + motion prompts are DERIVED from these fields plus the
 * parent scene's shared context (see `shot-list.derive.ts`).
 */
export const shotSpecSchema = z.object({
  shotNumber: z.number().meta({
    description: '1-based order of this shot within its scene',
  }),
  framing: shotFramingSchema.meta({
    description: 'Framing and subject start-state for the start frame',
  }),
  action: z.string().meta({
    description:
      'The ONE primary action that happens during this shot (e.g. "she turns and reaches for the door handle"). One action per shot.',
  }),
  cameraMovement: shotCameraMovementSchema.meta({
    description: 'Exactly one camera move paired with a pacing adverb',
  }),
  soundCue: z.string().meta({
    description:
      'On-screen SFX / ambience hook for audio-capable models (e.g. "door creak, distant traffic"). Empty string when none.',
  }),
  durationSeconds: z.number().meta({
    description: `Shot duration in seconds. At least ${MIN_SHOT_DURATION_SECONDS}; the scene's shots sum to at most ${MAX_SCENE_DURATION_SECONDS}.`,
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
  // `.min(1).max()` compile to JSON-Schema minItems/maxItems — NOT an `anyOf`
  // union — so the count bound is enforced at parse time without touching the
  // zero-union budget (asserted in the union-budget test). The per-shot 3s
  // floor and 15s scene-sum cap are cross-field and can't be expressed
  // union-free per field; they stay prompt-only (the field descriptions) and
  // are enforced by the #910 render-layer consumer.
  shots: z
    .array(shotSpecSchema)
    .min(1)
    .max(MAX_SHOTS_PER_SCENE)
    .meta({
      description: `Ordered list of 1..${MAX_SHOTS_PER_SCENE} shots. A short scene with no internal cut is a single shot.`,
    }),
});

export type SceneWithShots = z.infer<typeof sceneWithShotsSchema>;

// ============================================================================
// Top-level shot-list analysis result
// ============================================================================

/**
 * The full structured output of the shot-list analysis pass. Mirrors the
 * pre-#1035 single-call scene-split result but with scenes that own shot
 * lists. Kept union-free (see file header) to isolate the Anthropic 16-union
 * budget.
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
 * Inferred result of the shot-list analysis pass. The render-layer rewire
 * (#910) consumes this when scene-split switches to the shot-list schema; kept
 * exported now as the published analysis contract so #910 can adopt it without
 * a churn to this file.
 * @public
 */
export type SceneWithShotsResult = z.infer<typeof sceneWithShotsResultSchema>;
