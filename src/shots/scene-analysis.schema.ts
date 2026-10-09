import { z } from 'zod';

// ============================================================================
// Strict structured-output note
// ============================================================================
//
// These schemas are sent to the LLM as native structured-output JSON Schemas
// (`outputSchema` on `chat()`), which the provider compiles into a strict
// grammar that GUARANTEES conformance. Anthropic caps that grammar at 16
// union-typed parameters per request, and `convertSchemaToJsonSchema` compiles
// every `.catch(default)` / `.optional()` field into a `["T","null"]` union —
// so defensive `.catch()` defaults (which previously absorbed lenient
// `json_object` output) would silently blow the union budget and force the old
// fallback path. With strict output the model is REQUIRED to emit every field,
// so `.catch()` is both unnecessary and harmful here: keep these schemas free
// of `.catch()` and prefer required-but-emptyable fields ('' / [] / false) over
// `.optional()`.
//
// Resilience for streaming partial-scene parsing lives in
// `streaming-scene-parser.ts` (settled-prefix `safeParse`, ignore the trailing
// partial entry — not a second schema), and frame.metadata is stored as a
// `$type<Scene>()` cast (never re-parsed on read), so dropping `.catch()` here
// does not weaken any DB-read path.

// ============================================================================
// Character Bible Schemas
// ============================================================================

// Descriptions are short labels on purpose: they count toward Anthropic's
// strict-output grammar budget (#1035), so the vocabulary and format rules
// live in the `phase/scene-bibles-chat` prompt, which is not budgeted.
/**
 * One outfit of a character (#2015). `lookId` is a slug the bibles call makes
 * up (`gala_gown`); once the cast is persisted it is the `character_looks.id`.
 */
const characterLookEntrySchema = z.object({
  lookId: z.string(),
  name: z.string(),
  clothing: z.string(),
  // Hair, makeup, injuries, accessories; '' when none. On the default look
  // this holds what the bible called distinguishing features (#2065).
  styling: z.string(),
});
export type CharacterLookEntry = z.infer<typeof characterLookEntrySchema>;

export const characterBibleEntrySchema = z.object({
  characterId: z.string(),
  name: z.string(),
  age: z.string().meta({ description: 'Number or range' }),
  gender: z.string(),
  ethnicity: z.string(),
  physicalDescription: z.string(),
  // The outfit worn here: the default look's, or — in a shot's prompt context
  // — the look that shot's scene picks. Always `looks[0].clothing`.
  standardClothing: z.string(),
  // Every outfit (#2015), the one worn first: the default look off the
  // bibles call, the scene's pick in a shot's prompt context. An entry stored
  // before looks parses to none, and `withBibleLooks` gives it a default
  // look from `standardClothing`. The bibles call sends a leaner shape of
  // its own (`characterBibleWireEntrySchema`).
  looks: z.preprocess(
    (value) => value ?? [],
    z.array(characterLookEntrySchema)
  ),
  // No `distinguishingFeatures` (#2065): a permanent mark is part of
  // `physicalDescription`, the rest is the default look's `styling`. An
  // entry written before that is folded at the seam (`foldLegacyFeatures`).
  // Performance (#1561). Guidance lives in the bible prompt (grammar budget).
  personality: z.string(),
  movement: z.string(),
  // Hearable Voice Design brief (#1629). Drafted with the rest of the bible
  // so the Voice field is filled at Script, and Generate uses it as-is.
  // The brief's shape is in the bibles prompt; the label was trimmed to
  // make room for looks in the grammar budget (#2015).
  voiceDescription: z.string().meta({
    description: 'Hearable Voice Design brief. No appearance',
  }),
  // Narrator, radio voice, a caller on the phone: a voice with no face, so no
  // sheet, no talent match, no place in an image prompt (#1585).
  voiceOnly: z.boolean().meta({ description: 'Heard but never seen' }),
  // What the character is rendered as (#2017), filled from the sequence's
  // style by `bibleFromWire`, never asked of the model. '' when voice-only.
  rendering: z.string(),
  // Person vs robot/animal/object. Legal `real` is never a bible fact —
  // it is stamped on the character row from a signed talent or upload (#1682).
  isPerson: z
    .boolean()
    .meta({ description: 'Person, not robot/animal/object' }),
  consistencyTag: z.string().meta({ description: 'snake_case name slug' }),
});

// ============================================================================
// Element Bible Schemas (user-uploaded reference images + detected recurring
// products/objects that get an auto-generated reference image)
// ============================================================================

/**
 * First appearance of a bible entry in the script. `sceneId` is NOT part of the
 * LLM output (#1035: scene ids are minted server-side, and the bibles call runs
 * in parallel with the scenes call) — the workflow derives the owning scene
 * from `lineNumber` against the resolved boundary slices.
 */
const firstMentionSchema = z.object({
  text: z.string(),
  lineNumber: z.number().meta({ description: 'Gutter line' }),
});

export const elementBibleEntrySchema = z.object({
  token: z.string().meta({ description: 'UPPERCASE script token' }),
  description: z.string(),
  consistencyTag: z.string().meta({ description: 'Short slug' }),
  firstMention: firstMentionSchema,
});

// ============================================================================
// Location Bible Schemas
// ============================================================================

export const locationBibleEntrySchema = z.object({
  locationId: z.string(),
  name: z.string().meta({
    description:
      'Physical place name without slugline markers or a time-of-day suffix (INT. OFFICE - DAY and INT. OFFICE - NIGHT both become OFFICE); time of day belongs to the scene. Preserve genuine place-name words such as Night Owl Cafe. For an unspecified remote video-call location, use a participant-named physical setting',
  }),
  type: z.enum(['interior', 'exterior', 'both']),
  description: z.string(),
  architecturalStyle: z.string(),
  keyFeatures: z.string(),
  ambiance: z.string(),
  consistencyTag: z.string().meta({ description: 'snake_case name slug' }),
  firstMention: firstMentionSchema,
});

/**
 * `firstMention` as stored/consumed downstream: the LLM's `{ text, lineNumber }`
 * plus the server-derived owning scene id (#1035 — the bibles call cannot know
 * scene ids, which are minted server-side after boundary resolution).
 */
type FirstMentionWithScene = z.infer<typeof firstMentionSchema> & {
  sceneId: string;
};

// ============================================================================
// Project Metadata Schema
// ============================================================================

// Title-only (#1035): `aspectRatio` is a user setting and `generatedAt` was an
// LLM-invented timestamp — neither was ever read.
export const projectMetadataSchema = z.object({
  title: z
    .string()
    .meta({ description: 'Project title extracted from the script' }),
});

// ============================================================================
// Prompt Schemas
// ============================================================================

// No longer part of `visualPromptSchema` (#1035): the LLM composed these nine
// fields per frame but nothing ever read them (`frame_prompt_versions` stored
// them as history only). The schema survives solely to type old DB rows via
// `VisualPromptComponents` — see `frame-prompt-versions.ts`'s `$type<>()`.
const visualPromptComponentsSchema = z.object({
  sceneDescription: z
    .string()
    .meta({ description: 'Overall scene action and composition description' }),
  subject: z.string().meta({ description: 'Main subject or character focus' }),
  environment: z
    .string()
    .meta({ description: 'Setting, location, and background details' }),
  lighting: z
    .string()
    .meta({ description: 'Light sources, quality, direction, and mood' }),
  camera: z
    .string()
    .meta({ description: 'Camera angle, lens choice, and framing' }),
  composition: z
    .string()
    .meta({ description: 'Visual arrangement and focal points' }),
  style: z
    .string()
    .meta({ description: 'Artistic style and visual treatment' }),
  technical: z.string().meta({
    description: 'Technical parameters: resolution, quality settings',
  }),
  atmosphere: z
    .string()
    .meta({ description: 'Mood, emotion, and ambient feeling' }),
});

const visualPromptSchema = z.object({
  fullPrompt: z.string().meta({
    description: 'Complete image generation prompt with all visual details',
  }),
});

// No longer part of `motionPromptSchema` (#1035): `buildMotionShotPrompt` uses
// only `fullPrompt`/`dialogue`/`audio`, so the eight camera fields were pure
// write-only output cost per shot. Kept solely to type old `shot_prompt_versions`
// rows via `MotionPromptComponents`.
const motionPromptComponentsSchema = z.object({
  cameraMovement: z.string().meta({
    description:
      'The single primary camera motion for this shot (pan, tilt, dolly, truck, zoom) — exactly one move, never stacked',
  }),
  startPosition: z
    .string()
    .meta({ description: 'Camera starting position and framing' }),
  endPosition: z
    .string()
    .meta({ description: 'Camera ending position and framing' }),
  durationSeconds: z
    .number()
    .meta({ description: 'Shot duration in seconds (typically 3-15)' }),
  speed: z.string().meta({
    description:
      'Movement speed: slow, medium, or brisk — never "fast" (it triggers chaotic motion in video models)',
  }),
  smoothness: z.string().meta({
    description: 'Motion quality: jerky, natural, smooth, ultra-smooth',
  }),
  subjectTracking: z
    .string()
    .meta({ description: 'How camera follows subject movement' }),
  equipment: z.string().meta({
    description: 'Suggested equipment: handheld, gimbal, dolly, crane',
  }),
});

// No longer part of `motionPromptSchema` (#1035): video-model params come from
// `models.ts` config and duration from scene metadata; these were never read.
// Kept solely to type old `shot_prompt_versions` rows via `MotionPromptParameters`.
const motionPromptParametersSchema = z.object({
  durationSeconds: z
    .number()
    .meta({ description: 'Override duration in seconds' }),
  fps: z.number().meta({ description: 'Frames per second (24, 30, 60)' }),
  motionAmount: z
    .enum(['low', 'medium', 'high'])
    .meta({ description: 'Amount of motion: low, medium, high' }),
  cameraControl: z
    .object({
      pan: z.number().meta({ description: 'Horizontal rotation in degrees' }),
      tilt: z.number().meta({ description: 'Vertical rotation in degrees' }),
      zoom: z.number().meta({ description: 'Zoom factor (1.0 = no zoom)' }),
      movement: z
        .string()
        .meta({ description: 'Direction of camera movement' }),
    })
    .meta({ description: 'Precise camera control parameters' }),
});

const dialogueLineSchema = z.object({
  character: z.string().meta({
    description:
      'Speaker, spelled as the cast list spells it; empty only for a voice nobody could attribute',
  }),
  line: z.string(),
  tone: z.string().meta({
    description:
      'Voice tone and emotion for delivery (e.g., "calm serious", "trembling frustrated", "whispered urgent")',
  }),
});

const dialogueSchema = z.object({
  presence: z
    .boolean()
    .meta({ description: 'Whether dialogue is present in scene' }),
  lines: z
    .array(dialogueLineSchema)
    .meta({ description: 'Array of dialogue lines in the scene' }),
});

/**
 * The dialogue shape as STORED and as the editor sends it back (#1559) —
 * `dialogueSchema` plus the voice element a user bound to each line. Kept
 * apart from the wire schema above so `voiceToken` never reaches the LLM,
 * which has no way to know which elements exist and would invent a token.
 */
export const storedMotionDialogueSchema = z.object({
  presence: z.boolean(),
  lines: z.array(
    dialogueLineSchema.extend({ voiceToken: z.string().optional() })
  ),
});

const motionAudioSchema = z.object({
  ambientSound: z.string().meta({
    description:
      'Background ambient sound (e.g., "quiet office hum", "rain against windows", "bustling street")',
  }),
  soundEffects: z.array(z.string()).meta({
    description:
      'Specific sound effects timed to actions (e.g., "door slam", "glass clinking", "footsteps on gravel")',
  }),
});

const EMPTY_MOTION_DIALOGUE = { presence: false, lines: [] };
const EMPTY_MOTION_AUDIO = { ambientSound: '', soundEffects: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fill omitted/null dialogue+audio so a non-enforcing route (or a fixture
 * that skips the keys) still parses. `z.preprocess` is parse-only —
 * `z.toJSONSchema` emits the inner object, so the provider schema stays
 * required objects with `additionalProperties: false` (Anthropic rejects
 * `.nullish()` anyOf branches that omit that flag).
 */
function coerceNullishMotionFields(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  return {
    ...raw,
    dialogue: raw.dialogue ?? EMPTY_MOTION_DIALOGUE,
    audio: raw.audio ?? EMPTY_MOTION_AUDIO,
  };
}

export const motionPromptSchema = z.preprocess(
  coerceNullishMotionFields,
  z.object({
    fullPrompt: z.string().meta({
      description:
        'Complete motion prompt describing camera movement, action, and dialogue performance',
    }),
    dialogue: dialogueSchema.meta({
      description:
        'Dialogue lines from the scene to inform audio/motion models. presence=false and lines=[] when none.',
    }),
    audio: motionAudioSchema.meta({
      description:
        'Audio direction for models that generate sound alongside video. Empty ambientSound/soundEffects when none.',
    }),
  })
);

// ============================================================================
// Music Design Schema (replaces audioDesign for new shots)
// ============================================================================

export const musicDesignSchema = z.object({
  presence: z.enum(['none', 'minimal', 'moderate', 'full']).meta({
    description:
      'How prominent the music should be: none, minimal, moderate, full',
  }),
  style: z.string().meta({
    description:
      'Music genre or style (e.g., "orchestral", "electronic ambient")',
  }),
  mood: z.string().meta({
    description: 'Emotional quality of the music (e.g., "tense", "uplifting")',
  }),
  atmosphere: z.string().meta({
    description: 'Environmental atmosphere (e.g., "busy city street")',
  }),
});

// ============================================================================
// Audio Design Schemas (deprecated — kept for backward compat with old shots)
// ============================================================================

const musicSchema = z.object({
  presence: z.enum(['none', 'minimal', 'moderate', 'full']).meta({
    description:
      'How prominent the music should be: none, minimal, moderate, full',
  }),
  style: z.string().meta({
    description:
      'Music genre or style (e.g., "orchestral", "electronic ambient")',
  }),
  mood: z.string().meta({
    description: 'Emotional quality of the music (e.g., "tense", "uplifting")',
  }),
  rationale: z
    .string()
    .meta({ description: 'Explanation for the music choices' }),
});

const soundEffectSchema = z.object({
  sfxId: z
    .string()
    .meta({ description: 'Unique identifier for this sound effect' }),
  type: z.string().meta({
    description: 'Sound effect category (e.g., "ambient", "foley", "impact")',
  }),
  description: z.string().meta({
    description: 'Description of the sound (e.g., "distant thunder rumble")',
  }),
  timing: z.string().meta({
    description: 'When the sound plays (e.g., "scene start", "on action")',
  }),
  volume: z
    .enum(['low', 'medium', 'high'])
    .meta({ description: 'Relative volume level: low, medium, high' }),
  spatialPosition: z
    .string()
    .meta({ description: 'Audio positioning: left, center, right, surround' }),
});

const ambientSchema = z.object({
  roomTone: z.string().meta({
    description: 'Background room ambience (e.g., "quiet office hum")',
  }),
  atmosphere: z.string().meta({
    description: 'Environmental atmosphere (e.g., "busy city street")',
  }),
});

const audioDesignSchema = z.object({
  music: musicSchema.meta({ description: 'Background music specifications' }),
  soundEffects: z
    .array(soundEffectSchema)
    .meta({ description: 'Array of sound effects for the scene' }),
  dialogue: dialogueSchema.meta({
    description: 'Dialogue and speech specifications',
  }),
  ambient: ambientSchema.meta({ description: 'Ambient sound design' }),
});

// ============================================================================
// Continuity Schema
// ============================================================================

const continuitySchema = z.object({
  characterTags: z.array(z.string()).meta({
    description:
      "Snake_case slug of each character's name as written in the script (e.g., 'GIRL ONE' → 'girl_one'). Optional descriptive context may be appended after the name slug (e.g., 'girl_one_bathroom_morning'). One entry per character appearing in the scene.",
  }),
  // The look each character wears in this scene (#2015): character tag →
  // `character_looks.id`. A character with no entry wears its default look,
  // so a scene stored before looks — which has no map at all — is every
  // character in its default. Optional, not defaulted: continuity is read
  // as typed JSON straight off the row (three SQL mappers, no parse seam),
  // so a `.default({})` here would never run for a stored scene.
  characterLooks: z.record(z.string(), z.string()).optional(),
  environmentTag: z.string().meta({
    description:
      'Snake_case tag matching the location bible consistencyTag format',
  }),
  // `.nullish()` (not `.optional()`) so native strict output can emit `null`
  // when no elements are referenced. Consumers already read this as
  // `?.elementTags ?? []`. Do not reuse this on a schema sent as
  // `outputSchema`: TanStack's converter leaves `anyOf` object arms without
  // `additionalProperties: false`, which Anthropic rejects.
  elementTags: z.array(z.string()).nullish().meta({
    description:
      'UPPERCASE element tokens referenced in this scene (null when none)',
  }),
  colorPalette: z.string().optional().meta({
    description:
      'Optional user-authored palette override; leave empty during analysis. The sequence style owns palette.',
  }),
  lightingSetup: z.string(),
  styleTag: z.string(),
});

/**
 * Visual prompt generation response. Scene `continuity` (membership) is produced
 * upstream by scene-split, so the visual-prompt LLM only authors the image
 * prompt and no longer emits continuity. See #867.
 */
export const visualPromptResultSchema = z.object({
  visual: visualPromptSchema.meta({
    description: 'Image generation prompt data',
  }),
});

// ============================================================================
// Original Script Schema
// ============================================================================

export const originalScriptSchema = z.object({
  extract: z
    .string()
    .meta({ description: 'Original script text for this scene' }),
  dialogue: z
    .array(dialogueLineSchema)
    .meta({ description: 'Dialogue lines extracted from the script' }),
});

// ============================================================================
// Scene Metadata Schema
// ============================================================================

export const sceneMetadataSchema = z.object({
  title: z.string().meta({ description: 'Short descriptive scene title' }),
  durationSeconds: z.number().meta({
    description: 'Estimated scene duration in seconds (typically 3-15)',
  }),
  location: z.string(),
  timeOfDay: z.string(),
  storyBeat: z
    .string()
    .meta({ description: 'Narrative purpose of this scene in the story' }),
});

// ============================================================================
// Scene Schema
// ============================================================================

const sceneSchema = z.object({
  sceneId: z
    .string()
    .meta({ description: 'Unique identifier for this scene (required)' }),
  sceneNumber: z
    .number()
    .meta({ description: 'Scene order number starting from 1 (required)' }),
  originalScript: originalScriptSchema.meta({
    description: 'Original script content for this scene',
  }),
  metadata: sceneMetadataSchema
    .optional()
    .meta({ description: 'Scene metadata and context' }),
  // `prompts` removed (#713): visual prompts live in `frame_prompt_versions`
  // (mirrored on `frame.imagePrompt`) and motion prompts in
  // `shot_prompt_versions` (mirrored on `shot.motionPrompt` + dialogue/audio
  // columns). The Scene metadata no longer carries generated prompts.
  musicDesign: musicDesignSchema
    .optional()
    .meta({ description: 'Music classification for this scene (new shots)' }),
  /** @deprecated Kept for backward compat with old shots — use musicDesign */
  audioDesign: audioDesignSchema
    .optional()
    .meta({ description: 'Audio and sound design specs (deprecated)' }),
  continuity: continuitySchema
    .optional()
    .meta({ description: 'Continuity tracking for scene consistency' }),
  sourceImageUrl: z
    .string()
    .optional()
    .meta({ description: 'URL of generated or uploaded source image' }),
});

// ============================================================================
// Top-Level Scene Analysis Schema
// ============================================================================

export const sceneAnalysisSchema = z.object({
  projectMetadata: projectMetadataSchema.meta({
    description: 'Project-level metadata extracted from script',
  }),
  characterBible: z
    .array(characterBibleEntrySchema)
    .meta({ description: 'Character descriptions for visual consistency' }),
  locationBible: z
    .array(locationBibleEntrySchema)
    .meta({ description: 'Location descriptions for visual consistency' }),
  elementBible: z.array(elementBibleEntrySchema).optional().meta({
    description:
      'Element descriptions (logos, products, recurring objects) with UPPERCASE script tokens — user-uploaded or detected recurring products',
  }),
  scenes: z
    .array(sceneSchema)
    .meta({ description: 'Array of analyzed scenes from the script' }),
});

// ============================================================================
// TypeScript Type Export
// ============================================================================

export type SceneAnalysis = z.infer<typeof sceneAnalysisSchema>;
/**
 * Analysis scene. `shots` is attached after the shot-list pass (#1486) and is
 * not part of the (unused) `sceneSchema` LLM wire shape. `originalScript` is
 * overridden for the same reason: its stored lines carry `shotNumber` /
 * `voiceToken`, which the wire schema never publishes (see `DialogueLine`).
 */
export type Scene = Omit<z.infer<typeof sceneSchema>, 'originalScript'> & {
  originalScript: { extract: string; dialogue: DialogueLine[] };
  shots?: import('./shot-list.schema').ShotSpec[];
};
export type CharacterBibleEntry = z.infer<typeof characterBibleEntrySchema>;

/**
 * What a talent sheet's `metadata` holds: a bible entry describing the
 * TALENT, with the talent's own distinguishing features. Not a character's
 * (#2065 moved those to the default look); this one stays.
 */
export const talentSheetMetadataSchema = characterBibleEntrySchema
  .omit({ rendering: true })
  .extend({
    distinguishingFeatures: z.string(),
  });
export type TalentSheetMetadata = z.infer<typeof talentSheetMetadataSchema>;
// Bible entry types as consumed downstream: firstMention carries the
// server-derived sceneId (see FirstMentionWithScene). The raw z.infer of the
// entry schemas is the LLM wire shape only.
export type LocationBibleEntry = Omit<
  z.infer<typeof locationBibleEntrySchema>,
  'firstMention'
> & { firstMention: FirstMentionWithScene };
export type ElementBibleEntry = Omit<
  z.infer<typeof elementBibleEntrySchema>,
  'firstMention'
> & { firstMention: FirstMentionWithScene };
export type VisualPromptComponents = z.infer<
  typeof visualPromptComponentsSchema
>;
export type MotionPrompt = z.infer<typeof motionPromptSchema>;
export type MotionAudio = MotionPrompt['audio'];
/**
 * A dialogue line, plus the voice the USER bound to it (#1559).
 *
 * `voiceToken` is optional and off the LLM wire schema so analysis cannot
 * invent a token. Meanings: unset = generated TTS when the speaker has a
 * voiceId; `DIALOGUE` = bind the conversation clip; `__video_model__` =
 * the video model invents the voice; any other string = a user-uploaded
 * audio element (`SARAH_VOICE`). The picker writes the same value onto
 * every line of the shot.
 */
export type DialogueLine = z.infer<typeof dialogueLineSchema> & {
  voiceToken?: string;
  /**
   * The shot this line is spoken in, stamped on every line by the shot-list
   * call (#1585, `dialogueFromShots`). Absent only on rows from before
   * #1585, which keep their old meaning: every shot of the scene.
   * `dialogueForShot` is the filter and strips the stamp on the way out.
   */
  shotNumber?: number;
};
export type MotionDialogue = {
  presence: boolean;
  lines: DialogueLine[];
};
/**
 * The fields model-specific assembly (`buildMotionShotPrompt`) actually consumes:
 * the narrative base plus the dialogue/audio direction appended for audio-capable
 * video models. This is what a `shot_prompt_versions` motion row reconstructs to
 * at resolution time (#713). Stored rows and UI overrides may still omit
 * dialogue/audio (`null`); the LLM wire schema requires emptyable objects.
 */
export type AssemblableMotionPrompt = {
  fullPrompt: string;
  dialogue?: MotionDialogue | null;
  audio?: MotionAudio | null;
};
export type MotionPromptComponents = z.infer<
  typeof motionPromptComponentsSchema
>;
export type MotionPromptParameters = z.infer<
  typeof motionPromptParametersSchema
>;
export type Continuity = z.infer<typeof continuitySchema>;
export type SceneMetadata = z.infer<typeof sceneMetadataSchema>;
