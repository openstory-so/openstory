/**
 * The staleness dependency graph as data (#1595) — what you can edit, what
 * gets generated from it, and which edges the staleness check actually sees.
 *
 * Every field list here is transcribed from the hash bodies in
 * `src/shots/input-hash.ts`, the still snapshot in
 * `cast/server/workflows/sheet-snapshots.ts`, the clip pointer compare in
 * `shots/scene-segments.ts` and the Update-all plan in
 * `shots/server/update-stale-plan.ts`. When one of those changes, this graph
 * is the doc that has to move with it.
 */

export const GRAPH_MODES = ['start-frame', 'reference-only'] as const;

export type GraphMode = (typeof GRAPH_MODES)[number];

type NodeKind = 'input' | 'artifact';

/**
 * Band on the page. Inputs sit in the first three: what you write and set,
 * the optional team library, and the bibles — seeded once from the script
 * (by the LLM) or from the library (by casting / matching), then yours to
 * edit. Artifacts flow down from there.
 */
export const BANDS = [
  ['settings', 'You write and set'],
  ['library', 'Library · optional, reused across sequences'],
  ['bibles', 'Bibles · seeded from the script or the library, then yours'],
  ['references', 'References'],
  ['prompts', 'Prompts'],
  ['renders', 'Renders'],
  ['cut', 'Cut'],
] as const;

type Band = (typeof BANDS)[number][0];

export type IgnoredItem = string | { gap: string };

export type GraphNode = {
  id: string;
  label: string;
  kind: NodeKind;
  band: Band;
  /** One line under the label in the detail panel. */
  summary: string;
  /** What the hash (or pointer) actually reads. */
  counts: string[];
  /**
   * Edited freely without anything going stale. A `{ gap }` entry is one
   * that SHOULD make something stale and does not — drawn with a warning.
   */
  ignored: IgnoredItem[];
  /** Where the verdict is stored, for artifacts. */
  storedAs?: string;
  /** Only exists under this condition; drawn dashed. */
  optional?: string;
  /**
   * Append-only version rows with a selection pointer. Regenerating adds a
   * row; the pointer decides what downstream sees. Drawn as a stack.
   */
  versionedIn?: string;
};

/**
 * How downstream learns that an input moved:
 * - `hash`     — the field is in the artifact's input hash. Stale on change.
 * - `pointer`  — the artifact records which VERSION it used; selecting a
 *                different version makes it stale. Editing the version's
 *                inputs does nothing until a new version is selected.
 * - `untracked`— feeds the generation, but no staleness check reads it.
 *                `gap` marks the ones that should be tracked and are not;
 *                the rest are deliberate.
 * - `seeded`   — generated ONCE from upstream (the LLM at the Script stage,
 *                or casting / matching from the library) and then owned by
 *                the user. Later upstream edits never touch it.
 */
const TRACKINGS = ['hash', 'pointer', 'untracked', 'seeded'] as const;

export type Tracking = (typeof TRACKINGS)[number];

export type GraphEdge = {
  from: string;
  to: string;
  tracking: Tracking;
  /** An untracked edge that ought to be tracked. Drawn red. */
  gap?: true;
  /** Only present in this mode; absent = both modes. */
  mode?: GraphMode;
  /** Short reason shown in the detail panel. */
  note?: string;
};

export const GRAPH_NODES: readonly GraphNode[] = [
  // --- You write -----------------------------------------------------------
  {
    id: 'script',
    versionedIn: 'scene_script_versions',
    label: 'Script',
    kind: 'input',
    band: 'settings',
    summary: 'The scene text and its slugline, as split from your script.',
    counts: [
      'Scene extract, line number and the dialogue spoken in this shot',
      'INT./EXT. heading',
      'Time of day',
      'Story beat',
    ],
    ignored: [
      'Scene title',
      'Scene number',
      'Duration (a clip setting, not a prompt input)',
      'The generated prompts and continuity tags',
    ],
  },
  {
    id: 'character',
    label: 'Character',
    kind: 'input',
    band: 'bibles',
    summary:
      'Extracted from the script at the Script stage, rewritten by casting when a talent is matched, then yours to edit. A voice-only character (a narrator) has a row but never a sheet.',
    counts: [
      'Age, gender, ethnicity',
      'Physical description',
      'Standard clothing',
      'Distinguishing features',
      'Personality and movement (motion prompt only)',
      'Consistency tag (sheet only)',
    ],
    ignored: [
      'Name',
      'First mention',
      'The talent id itself (its look is copied into the fields above, and those count)',
      'Voice description',
    ],
  },
  {
    id: 'talent',
    optional: 'when a character is cast as library talent',
    label: 'Talent',
    kind: 'input',
    band: 'library',
    summary:
      'A library person. Cast onto a character automatically at the Script stage or by hand; casting copies their look, performance and voice onto the character once. These fields only reach a sequence through a regenerated talent sheet: edit the description and the character keeps the old face until the sheet is redone.',
    counts: ['Description', 'Reference photos'],
    ignored: ['Name'],
  },
  {
    id: 'location',
    label: 'Location',
    kind: 'input',
    band: 'bibles',
    summary:
      'Extracted from the script at the Script stage, linked to a library location when one matches, then yours to edit.',
    counts: [
      'Description',
      'Type, time of day, architectural style, key features, colour palette, lighting, ambiance (prompts only)',
    ],
    ignored: ['Name'],
  },
  {
    id: 'libraryLocation',
    optional: 'when a location is linked to the library',
    label: 'Library location',
    kind: 'input',
    band: 'library',
    summary:
      'A reusable location from the team library, matched onto a sequence location automatically or by hand. Its fields only reach a sequence through a regenerated reference image.',
    counts: ['Description', 'Reference photos'],
    ignored: ['Name'],
  },
  {
    id: 'element',
    optional: 'when the shot references one',
    label: 'Element',
    kind: 'input',
    band: 'bibles',
    summary:
      'A prop, effect, sound or clip referenced by @token. Detected in the script at the Script stage or added by hand, then yours to edit.',
    counts: [
      'Token and description (prompts)',
      'Image (still)',
      'Audio or video clip: sent as a reference when the video model takes one',
    ],
    ignored: [
      {
        gap: 'A changed audio or video clip never flags the clip that used it',
      },
    ],
  },
  // --- You set -------------------------------------------------------------
  {
    id: 'style',
    label: 'Style',
    kind: 'input',
    band: 'bibles',
    summary:
      'The look and motion config snapshotted onto the sequence: derived from the script by the auto style, or picked from the catalog.',
    counts: [
      'Mood, art style, lighting, colour palette, colour grading',
      'Camera work, reference films',
      'Medium, shots, pace, energy',
    ],
    ignored: [
      'Style name and description',
      'Edits to the catalog style once the sequence has its own snapshot',
    ],
  },
  {
    id: 'catalogStyle',
    label: 'Catalog style',
    kind: 'input',
    band: 'library',
    optional: 'when the style was picked rather than derived',
    summary:
      'A team or system style in the catalog. Picking it copies its config onto the sequence; the catalog row is never read again.',
    counts: ['Nothing directly'],
    ignored: ['Everything, once snapshotted onto the sequence'],
  },
  {
    id: 'aspectRatio',
    label: 'Aspect ratio',
    kind: 'input',
    band: 'settings',
    summary: 'The sequence frame shape.',
    counts: ['The ratio itself'],
    ignored: [],
  },
  {
    id: 'resolution',
    label: 'Resolution',
    kind: 'input',
    band: 'settings',
    summary: 'The render tier a clip is asked for.',
    counts: ['Nothing is compared today'],
    ignored: [
      'Stamped on each clip version so a 4K re-roll stays legible next to the 720p draft, but never compared',
    ],
  },
  {
    id: 'analysisModel',
    label: 'Script model',
    kind: 'input',
    band: 'settings',
    summary: 'The LLM that writes prompts.',
    counts: ['Model id'],
    ignored: [],
  },
  {
    id: 'imageModel',
    label: 'Image model',
    kind: 'input',
    band: 'settings',
    summary: 'The model that renders sheets and stills.',
    counts: ['Model id'],
    ignored: [],
  },
  {
    id: 'videoModel',
    label: 'Video model',
    kind: 'input',
    band: 'settings',
    summary:
      'The model that renders clips. Also decides which durations a shot can snap to and whether it can hear dialogue or take reference clips.',
    counts: ['Nothing is compared today'],
    ignored: [
      'Switching model starts a new render segment; the old clips stay, nothing reads stale',
    ],
  },
  {
    id: 'musicModel',
    label: 'Music model',
    kind: 'input',
    band: 'settings',
    summary: 'The model that renders the score.',
    counts: ['Nothing is compared today'],
    ignored: [{ gap: 'In the track hash, which nothing reads' }],
  },
  {
    id: 'duration',
    label: 'Shot duration',
    kind: 'input',
    band: 'settings',
    summary: 'Seconds per shot, snapped to the video model.',
    counts: ['Seconds (music prompt)'],
    ignored: ['Visual and motion prompts', 'The clip, once rendered'],
  },
  {
    id: 'startFrameMode',
    label: 'Start-frame mode',
    kind: 'input',
    band: 'settings',
    summary:
      'Animate a rendered still, or render straight from the reference sheets.',
    counts: ['On or off (motion prompt)'],
    ignored: [],
  },
  {
    id: 'voicesOn',
    label: 'Voices',
    kind: 'input',
    band: 'settings',
    summary:
      'Design an ElevenLabs voice for each speaking character. Per-character override on the card.',
    counts: ['Nothing is compared today'],
    ignored: ['Only decides whether a voice is designed at all'],
  },
  {
    id: 'musicOn',
    label: 'Music',
    kind: 'input',
    band: 'settings',
    summary: 'Include the score in the cut.',
    counts: ['On or off (export)'],
    ignored: [],
  },
  {
    id: 'sfxDialogue',
    label: 'SFX & dialogue',
    kind: 'input',
    band: 'settings',
    summary:
      'Append the dialogue lines and audio direction to the motion prompt when the video model can hear. Chosen per render in the scene editor.',
    counts: ['Nothing is compared today'],
    ignored: ['A render-time option; it is not stored on the shot'],
  },
  {
    id: 'stopAt',
    label: 'Stop at',
    kind: 'input',
    band: 'settings',
    summary:
      'How far a generation run goes: script, references, images, motion or music.',
    counts: ['Nothing'],
    ignored: ['It picks how far a run goes, never what is stale'],
  },
  {
    id: 'dialogue',
    label: 'Dialogue',
    kind: 'input',
    band: 'bibles',
    summary:
      'The lines spoken in a shot, assigned by the shot-list call at the Script stage. They ride on the motion prompt version and are appended at render; the panel binds a voice element to a line.',
    counts: [
      'Which voice is bound to which line (writes a new motion prompt version)',
    ],
    ignored: ['The wording: lines come from the script, edit them there'],
  },
  // --- References ----------------------------------------------------------
  {
    id: 'talentSheet',
    versionedIn: 'talent_sheet_variants',
    optional: 'when a character is cast as library talent',
    label: 'Talent sheet',
    kind: 'artifact',
    band: 'references',
    summary:
      'The talent as a sequence sees it. A cast character usually reuses this sheet as its own and always draws from it, so "the talent changed" means "the selected talent sheet changed".',
    counts: ['Talent description', 'Reference photo hashes', 'Image model'],
    ignored: ['Talent name'],
    storedAs: 'talent_sheets.inputHash',
  },
  {
    id: 'characterSheet',
    versionedIn: 'character_sheet_variants',
    label: 'Character sheet',
    kind: 'artifact',
    band: 'references',
    summary:
      "Turnaround sheet for a character in this sequence. When cast, it is usually the talent sheet reused; a costumed one is generated only when the role's clothing or features diverge from the talent.",
    counts: [
      'Character bible (age, gender, ethnicity, description, clothing, features, consistency tag)',
      'Talent sheet hash, when cast',
      'Style config',
      'Image model',
    ],
    ignored: [
      'Character name',
      'Personality and movement',
      'Voice-only characters never get one',
      {
        gap: 'A reference-only clip drawn from it stays fresh when a new version is selected',
      },
    ],
    storedAs: 'characters.sheetInputHash',
  },
  {
    id: 'voice',
    optional: 'when voices are on for a speaking character',
    label: 'Voice',
    kind: 'artifact',
    band: 'references',
    summary:
      'A designed ElevenLabs voice for a speaking character. Designed once and kept; nothing renders with it yet.',
    counts: ['Nothing is compared today'],
    ignored: [
      'Voice description edits ("Generate voice" releases the old one and designs again)',
      'Character bible edits',
    ],
    storedAs: 'characters.voiceId (no hash)',
  },
  {
    id: 'libraryLocationReference',
    versionedIn: 'location_sheet_variants',
    optional: 'when a location is linked to the library',
    label: 'Library location ref',
    kind: 'artifact',
    band: 'references',
    summary:
      'The library location as a sequence sees it: the location sheet draws from it and folds its hash in.',
    counts: [
      'Library location description',
      'Reference photo hashes',
      'Style config',
      'Image model',
    ],
    ignored: ['Name'],
    storedAs: 'location_library.referenceInputHash',
  },
  {
    id: 'locationSheet',
    versionedIn: 'location_sheet_variants',
    label: 'Location sheet',
    kind: 'artifact',
    band: 'references',
    summary: 'Reference image for a location in this sequence.',
    counts: [
      'Location description',
      'Library location reference hash, when linked',
      'Style config',
      'Image model',
    ],
    ignored: [
      'Name',
      'Type, time of day, architectural style, key features, colour palette, lighting, ambiance',
      {
        gap: 'A reference-only clip drawn from it stays fresh when a new version is selected',
      },
    ],
    storedAs: 'sequence_locations.referenceInputHash',
  },
  // --- Prompts -------------------------------------------------------------
  {
    id: 'visualPrompt',
    versionedIn: 'frame_prompt_versions',
    label: 'Visual prompt',
    kind: 'artifact',
    band: 'prompts',
    summary: 'The text the still is rendered from.',
    counts: [
      'Scene extract, heading, time of day, story beat',
      'Style config',
      'Character, location and element bibles, narrowed to this scene',
      'Aspect ratio',
      'Script model',
    ],
    ignored: ['Duration', 'Names and titles', 'The still it produces'],
    storedAs: 'frames.visualPromptInputHash',
  },
  {
    id: 'motionPrompt',
    versionedIn: 'shot_prompt_versions',
    label: 'Motion prompt',
    kind: 'artifact',
    band: 'prompts',
    summary: 'The text the clip is rendered from.',
    counts: [
      'Everything the visual prompt counts',
      'Character personality and movement',
      'The rendered still it was shown (start-frame mode)',
      'Start-frame mode',
    ],
    ignored: ['Duration', 'Names and titles'],
    storedAs: 'shots.motionPromptInputHash',
  },
  {
    id: 'musicPrompt',
    versionedIn: 'sequence_music_prompt_versions',
    label: 'Music prompt',
    kind: 'artifact',
    band: 'prompts',
    summary: 'One prompt for the whole sequence.',
    counts: [
      'Per scene: story beat, duration, heading, time of day',
      'Per scene: the visual prompt text',
      'Script model',
    ],
    ignored: [
      'Scene titles',
      {
        gap: 'The music track never reads stale from it; only Update all regenerates it',
      },
    ],
    storedAs: 'sequences.musicPromptInputHash',
  },
  // --- Renders -------------------------------------------------------------
  {
    id: 'still',
    versionedIn: 'frame_variants',
    label: 'Still',
    kind: 'artifact',
    band: 'renders',
    summary: 'The rendered start frame for a shot.',
    counts: [
      'Selected visual prompt text',
      'Image model',
      'Aspect ratio',
      'Selected character sheet versions',
      'Selected location sheet versions',
      'Element image URLs',
    ],
    ignored: ['Seed and size, unless set'],
    storedAs: 'frames.imageInputHash',
  },
  {
    id: 'clip',
    versionedIn: 'video_variants',
    label: 'Clip',
    kind: 'artifact',
    band: 'renders',
    summary: 'The rendered video for a shot.',
    counts: [
      'Which motion prompt version it rendered',
      'Which still version it rendered (start-frame mode)',
    ],
    ignored: [
      'Duration',
      'Video model (a different model is a different segment, not a stale one)',
      {
        gap: 'Reference sheets it was drawn from (reference-only mode): the manifest records no sheet versions',
      },
      {
        gap: 'Audio or video elements it was sent as references: the manifest does not record them',
      },
    ],
    storedAs: 'video_variants.manifest',
  },
  {
    id: 'musicTrack',
    versionedIn: 'sequence_music_variants',
    optional: 'when music is on',
    label: 'Music track',
    kind: 'artifact',
    band: 'renders',
    summary: 'The generated score.',
    counts: ['Nothing is compared today'],
    ignored: [
      {
        gap: 'Music prompt, tags, duration and music model: the hash is written and never compared',
      },
    ],
    storedAs: 'sequences.musicInputHash (written, never read)',
  },
  // --- Cut -----------------------------------------------------------------
  {
    id: 'export',
    label: 'Export',
    kind: 'artifact',
    band: 'cut',
    summary: 'The stitched MP4.',
    counts: ['Selected clip URL per shot, in order', 'Music URL, if included'],
    ignored: [],
    storedAs: 'sequence_exports.sourceShotsHash',
  },
];

const bibleToPrompt: GraphEdge[] = ['visualPrompt', 'motionPrompt'].flatMap(
  (to) => [
    { from: 'script', to, tracking: 'hash' as const },
    { from: 'character', to, tracking: 'hash' as const },
    { from: 'location', to, tracking: 'hash' as const },
    { from: 'element', to, tracking: 'hash' as const },
    { from: 'style', to, tracking: 'hash' as const },
    { from: 'aspectRatio', to, tracking: 'hash' as const },
    { from: 'analysisModel', to, tracking: 'hash' as const },
  ]
);

export const GRAPH_EDGES: readonly GraphEdge[] = [
  // Bibles — seeded once, never re-staled
  {
    from: 'script',
    to: 'style',
    tracking: 'seeded',
    note: 'the auto style derives a config from the script at the Script stage',
  },
  {
    from: 'catalogStyle',
    to: 'style',
    tracking: 'seeded',
    note: 'picking a style copies its config onto the sequence',
  },
  {
    from: 'script',
    to: 'character',
    tracking: 'seeded',
    note: 'the bibles call extracts the cast at the Script stage',
  },
  {
    from: 'talent',
    to: 'character',
    tracking: 'seeded',
    note: 'casting copies the talent look, performance and voice onto the bible',
  },
  {
    from: 'script',
    to: 'location',
    tracking: 'seeded',
    note: 'the bibles call extracts locations at the Script stage',
  },
  {
    from: 'libraryLocation',
    to: 'location',
    tracking: 'seeded',
    note: 'matching links the sequence location to the library one',
  },
  {
    from: 'script',
    to: 'element',
    tracking: 'seeded',
    note: 'the bibles call detects elements at the Script stage',
  },
  {
    from: 'script',
    to: 'dialogue',
    tracking: 'seeded',
    note: 'the shot-list call assigns every spoken line to a shot',
  },
  // References
  { from: 'talent', to: 'talentSheet', tracking: 'hash' },
  { from: 'imageModel', to: 'talentSheet', tracking: 'hash' },
  { from: 'character', to: 'characterSheet', tracking: 'hash' },
  {
    from: 'talentSheet',
    to: 'characterSheet',
    tracking: 'hash',
    note: 'the talent sheet hash is folded into the character sheet hash',
  },
  { from: 'style', to: 'characterSheet', tracking: 'hash' },
  {
    from: 'character',
    to: 'voice',
    tracking: 'untracked',
    note: 'the voice description is drafted from the bible once',
  },
  {
    from: 'talent',
    to: 'voice',
    tracking: 'untracked',
    note: 'a library voice is copied onto the character at cast, not designed',
  },
  { from: 'imageModel', to: 'characterSheet', tracking: 'hash' },
  { from: 'libraryLocation', to: 'libraryLocationReference', tracking: 'hash' },
  { from: 'style', to: 'libraryLocationReference', tracking: 'hash' },
  { from: 'imageModel', to: 'libraryLocationReference', tracking: 'hash' },
  {
    from: 'location',
    to: 'locationSheet',
    tracking: 'hash',
    note: 'description only',
  },
  { from: 'libraryLocationReference', to: 'locationSheet', tracking: 'hash' },
  { from: 'style', to: 'locationSheet', tracking: 'hash' },
  { from: 'imageModel', to: 'locationSheet', tracking: 'hash' },
  // Prompts
  ...bibleToPrompt,
  {
    from: 'still',
    to: 'motionPrompt',
    tracking: 'hash',
    mode: 'start-frame',
    note: 'the still is a vision input; a re-render changes its URL',
  },
  {
    from: 'startFrameMode',
    to: 'motionPrompt',
    tracking: 'hash',
    note: 'each mode uses a different prompt template',
  },
  { from: 'script', to: 'musicPrompt', tracking: 'hash' },
  { from: 'duration', to: 'musicPrompt', tracking: 'hash' },
  {
    from: 'visualPrompt',
    to: 'musicPrompt',
    tracking: 'hash',
    note: 'the visual prompt text grounds the music brief',
  },
  { from: 'analysisModel', to: 'musicPrompt', tracking: 'hash' },
  // Renders
  {
    from: 'visualPrompt',
    to: 'still',
    tracking: 'hash',
    note: 'the selected prompt text',
  },
  { from: 'imageModel', to: 'still', tracking: 'hash' },
  { from: 'aspectRatio', to: 'still', tracking: 'hash' },
  {
    from: 'characterSheet',
    to: 'still',
    tracking: 'pointer',
    note: 'the selected sheet version id',
  },
  {
    from: 'locationSheet',
    to: 'still',
    tracking: 'pointer',
    note: 'the selected sheet version id',
  },
  { from: 'element', to: 'still', tracking: 'hash', note: 'the image URL' },
  {
    from: 'motionPrompt',
    to: 'clip',
    tracking: 'pointer',
    note: 'the manifest records the prompt version',
  },
  {
    from: 'still',
    to: 'clip',
    tracking: 'pointer',
    mode: 'start-frame',
    note: 'the manifest records the still version',
  },
  {
    from: 'characterSheet',
    to: 'clip',
    tracking: 'untracked',
    gap: true,
    mode: 'reference-only',
    note: 'the sheets are the video references, but the manifest does not record them',
  },
  {
    from: 'locationSheet',
    to: 'clip',
    tracking: 'untracked',
    gap: true,
    mode: 'reference-only',
    note: 'the sheets are the video references, but the manifest does not record them',
  },
  {
    from: 'duration',
    to: 'clip',
    tracking: 'untracked',
    note: 'a re-snapped duration must not flag every clip',
  },
  {
    from: 'dialogue',
    to: 'clip',
    tracking: 'pointer',
    note: 'binding a voice writes a new motion prompt version, which the manifest records',
  },
  {
    from: 'element',
    to: 'clip',
    tracking: 'untracked',
    gap: true,
    note: 'an audio or video element goes as a reference when the model takes one; the manifest does not record it',
  },
  {
    from: 'resolution',
    to: 'clip',
    tracking: 'untracked',
    note: 'stamped on the version, never compared',
  },
  {
    from: 'videoModel',
    to: 'clip',
    tracking: 'untracked',
    note: 'a different model is a different segment, never a stale one',
  },
  {
    from: 'sfxDialogue',
    to: 'clip',
    tracking: 'untracked',
    note: 'a render-time option, not stored',
  },
  {
    from: 'musicModel',
    to: 'musicTrack',
    tracking: 'untracked',
    gap: true,
    note: 'in the track hash, which nothing reads',
  },
  {
    from: 'voicesOn',
    to: 'voice',
    tracking: 'untracked',
    note: 'decides whether a voice is designed at all',
  },
  {
    from: 'musicPrompt',
    to: 'musicTrack',
    tracking: 'untracked',
    gap: true,
    note: 'the track is never flagged; Update all at music depth regenerates it when the prompt regenerates',
  },
  // Cut
  {
    from: 'clip',
    to: 'export',
    tracking: 'hash',
    note: 'the selected clip URL',
  },
  { from: 'musicTrack', to: 'export', tracking: 'hash', note: 'the music URL' },
  {
    from: 'musicOn',
    to: 'export',
    tracking: 'hash',
    note: 'the music URL joins the export hash only when music is on',
  },
];

export const nodeById = (id: string): GraphNode | undefined =>
  GRAPH_NODES.find((n) => n.id === id);

export const edgesForMode = (mode: GraphMode): GraphEdge[] =>
  GRAPH_EDGES.filter((e) => !e.mode || e.mode === mode);

/** Does this edge propagate staleness on its own? */
export const propagates = (e: GraphEdge): boolean =>
  e.tracking === 'hash' || e.tracking === 'pointer';

export type Reach = {
  id: string;
  /** Edge that reached it, for the "via" copy. */
  via: GraphEdge;
};

/**
 * Everything that goes stale when `id` changes, in BFS order. Follows only
 * edges that propagate; an untracked or seeded edge stops the walk, which is the
 * whole point of drawing them differently.
 */
export function staleAfterEdit(id: string, mode: GraphMode): Reach[] {
  return walk(
    id,
    mode,
    (e) => e.from,
    (e) => e.to
  );
}

/** Everything whose change makes `id` stale, in BFS order. */
export function staleBecauseOf(id: string, mode: GraphMode): Reach[] {
  return walk(
    id,
    mode,
    (e) => e.to,
    (e) => e.from
  );
}

function walk(
  origin: string,
  mode: GraphMode,
  key: (e: GraphEdge) => string,
  next: (e: GraphEdge) => string
): Reach[] {
  const edges = edgesForMode(mode).filter(propagates);
  const seen = new Set<string>([origin]);
  const out: Reach[] = [];
  // for-of sees elements pushed during iteration, so the queue is the walk.
  const queue = [origin];
  for (const from of queue) {
    for (const e of edges) {
      if (key(e) !== from) continue;
      const to = next(e);
      if (seen.has(to)) continue;
      seen.add(to);
      out.push({ id: to, via: e });
      queue.push(to);
    }
  }
  return out;
}
