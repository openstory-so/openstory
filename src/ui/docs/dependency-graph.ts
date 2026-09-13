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

/** Band on the page: inputs sit in the first two, artifacts flow down. */
export type Band =
  | 'story'
  | 'settings'
  | 'references'
  | 'prompts'
  | 'renders'
  | 'cut';

export const BAND_ORDER: readonly Band[] = [
  'story',
  'settings',
  'references',
  'prompts',
  'renders',
  'cut',
];

export const BAND_LABELS: Record<Band, string> = {
  story: 'You write',
  settings: 'You set',
  references: 'References',
  prompts: 'Prompts',
  renders: 'Renders',
  cut: 'Cut',
};

export type GraphNode = {
  id: string;
  label: string;
  kind: NodeKind;
  band: Band;
  /** One line under the label in the detail panel. */
  summary: string;
  /** What the hash (or pointer) actually reads. */
  counts: string[];
  /** Edited freely without anything going stale. */
  ignored: string[];
  /** Where the verdict is stored, for artifacts. */
  storedAs?: string;
  /** Only exists under this condition; drawn dashed. */
  optional?: string;
};

/**
 * How downstream learns that an input moved:
 * - `hash`     — the field is in the artifact's input hash. Stale on change.
 * - `pointer`  — the artifact records which VERSION it used; selecting a
 *                different version makes it stale. Editing the version's
 *                inputs does nothing until a new version is selected.
 * - `cascade`  — never flagged stale on its own; Update all regenerates it
 *                only when the upstream artifact regenerates in the same run.
 * - `untracked`— feeds the generation, but no staleness check reads it.
 */
export const TRACKINGS = ['hash', 'pointer', 'cascade', 'untracked'] as const;

export type Tracking = (typeof TRACKINGS)[number];

export type GraphEdge = {
  from: string;
  to: string;
  tracking: Tracking;
  /** Only present in this mode; absent = both modes. */
  mode?: GraphMode;
  /** Short reason shown in the detail panel. */
  note?: string;
};

export const GRAPH_NODES: readonly GraphNode[] = [
  // --- You write -----------------------------------------------------------
  {
    id: 'script',
    label: 'Script',
    kind: 'input',
    band: 'story',
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
    band: 'story',
    summary:
      'The character bible entry, after casting has rewritten it. A voice-only character (a narrator) has a row but never a sheet.',
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
      'Which library talent is cast',
      'Voice description',
    ],
  },
  {
    id: 'talent',
    optional: 'when a character is cast as library talent',
    label: 'Talent',
    kind: 'input',
    band: 'story',
    summary: 'A library person a character is cast as.',
    counts: ['Description', 'Reference photos'],
    ignored: ['Name'],
  },
  {
    id: 'location',
    label: 'Location',
    kind: 'input',
    band: 'story',
    summary: 'The location bible entry for this sequence.',
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
    band: 'story',
    summary: 'A reusable location from the team library.',
    counts: ['Description', 'Reference photos'],
    ignored: ['Name'],
  },
  {
    id: 'element',
    optional: 'when the shot references one',
    label: 'Element',
    kind: 'input',
    band: 'story',
    summary: 'A prop or effect referenced by @token.',
    counts: ['Token and description (prompts)', 'Image (still)'],
    ignored: [],
  },
  // --- You set -------------------------------------------------------------
  {
    id: 'style',
    label: 'Style',
    kind: 'input',
    band: 'settings',
    summary: 'The look and motion config snapshotted onto the sequence.',
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
    id: 'aspectRatio',
    label: 'Aspect ratio',
    kind: 'input',
    band: 'settings',
    summary: 'The sequence frame shape.',
    counts: ['The ratio itself'],
    ignored: ['Resolution tier'],
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
  // --- References ----------------------------------------------------------
  {
    id: 'talentSheet',
    optional: 'when a character is cast as library talent',
    label: 'Talent sheet',
    kind: 'artifact',
    band: 'references',
    summary: 'Turnaround sheet for a library person.',
    counts: ['Talent description', 'Reference photo hashes', 'Image model'],
    ignored: ['Talent name'],
    storedAs: 'talent_sheets.inputHash',
  },
  {
    id: 'characterSheet',
    label: 'Character sheet',
    kind: 'artifact',
    band: 'references',
    summary: 'Turnaround sheet for a character in this sequence.',
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
    optional: 'when a location is linked to the library',
    label: 'Library location ref',
    kind: 'artifact',
    band: 'references',
    summary: 'Reference image for a library location.',
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
    ],
    storedAs: 'sequence_locations.referenceInputHash',
  },
  // --- Prompts -------------------------------------------------------------
  {
    id: 'visualPrompt',
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
    label: 'Music prompt',
    kind: 'artifact',
    band: 'prompts',
    summary: 'One prompt for the whole sequence.',
    counts: [
      'Per scene: story beat, duration, heading, time of day',
      'Per scene: the visual prompt text',
      'Script model',
    ],
    ignored: ['Scene titles'],
    storedAs: 'sequences.musicPromptInputHash',
  },
  // --- Renders -------------------------------------------------------------
  {
    id: 'still',
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
      'Reference sheets (reference-only mode)',
    ],
    storedAs: 'video_variants.manifest',
  },
  {
    id: 'musicTrack',
    optional: 'when music is on',
    label: 'Music track',
    kind: 'artifact',
    band: 'renders',
    summary: 'The generated score.',
    counts: ['Nothing is compared today'],
    ignored: ['Music prompt edits, tags, duration, music model'],
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
    mode: 'reference-only',
    note: 'the sheets are the video references, but the manifest does not record them',
  },
  {
    from: 'locationSheet',
    to: 'clip',
    tracking: 'untracked',
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
    from: 'musicPrompt',
    to: 'musicTrack',
    tracking: 'cascade',
    note: 'Update all at music depth regenerates the track when the prompt regenerates',
  },
  // Cut
  {
    from: 'clip',
    to: 'export',
    tracking: 'hash',
    note: 'the selected clip URL',
  },
  { from: 'musicTrack', to: 'export', tracking: 'hash', note: 'the music URL' },
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
  /** Hops from the origin; 1 = direct. */
  depth: number;
};

/**
 * Everything that goes stale when `id` changes, in BFS order. Follows only
 * edges that propagate; a cascade/untracked edge stops the walk, which is the
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
  let frontier = [origin];
  for (let depth = 1; frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const from of frontier) {
      for (const e of edges) {
        if (key(e) !== from) continue;
        const to = next(e);
        if (seen.has(to)) continue;
        seen.add(to);
        out.push({ id: to, via: e, depth });
        nextFrontier.push(to);
      }
    }
    frontier = nextFrontier;
  }
  return out;
}
