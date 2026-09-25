/**
 * The staleness dependency graph as data (#1595) — what you can edit, what
 * gets generated from it, and which edges the staleness check actually sees.
 *
 * Every field list here is transcribed from the hash bodies in
 * `src/shots/input-hash.ts`, the still snapshot in
 * `cast/server/workflows/sheet-snapshots.ts`, the clip pointer compare in
 * `shots/scene-segments.ts`, the reference provenance keys in
 * `motion/reference-provenance.ts`, the recording key in
 * `shots/shot-dialogue.ts`, the track compare in
 * `audio/music-track-staleness.ts` and the Update-all plan in
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
    summary:
      'The scene text and its slugline, as split from your script. Heading, time of day, story beat and continuity tags are versioned with the text, so a stale shot names the field that moved.',
    counts: [
      'Scene extract, line number and the dialogue spoken in this shot',
      'INT./EXT. heading',
      'Time of day',
      'Story beat',
      'Continuity tags: they pick which characters, locations and elements the prompts read',
    ],
    ignored: [
      'Scene title',
      'Scene number',
      'Duration (a clip setting, not a prompt input)',
      'The generated prompts',
    ],
  },
  {
    id: 'character',
    versionedIn: 'character_bible_versions',
    label: 'Character',
    kind: 'input',
    band: 'bibles',
    summary:
      'Extracted from the script at the Script stage, rewritten by casting when a talent is matched, then yours to edit. Every change is a version, so a stale shot names the field that moved. A voice-only character (a narrator) has a row but never a sheet.',
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
      'A library person. Cast onto a character automatically at the Script stage or by hand; casting copies their look, performance and voice onto the character bible once. The character sheet keeps reading the talent: its description and default sheet are in the sheet hash, so editing either re-stales the cast character sheet.',
    counts: [
      'Description (talent sheet and cast character sheet)',
      'Reference photos',
      'The default talent sheet image and look (cast character sheet)',
    ],
    ignored: [
      'Name',
      {
        gap: 'A redesigned talent voice never reaches a cast character: the id is copied once at cast, and talent voices have no history to select from',
      },
    ],
  },
  {
    id: 'location',
    versionedIn: 'location_bible_versions',
    label: 'Location',
    kind: 'input',
    band: 'bibles',
    summary:
      'Extracted from the script at the Script stage, linked to a library location when one matches, then yours to edit. Every change is a version, so a stale shot names the field that moved.',
    counts: [
      'Description',
      'Type, time of day, architectural style, key features, colour palette, lighting, ambiance',
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
      'Its media URL, stamped on every clip it was sent to (referenceKeys)',
    ],
    ignored: ['Consistency tag'],
  },
  // --- You set -------------------------------------------------------------
  {
    id: 'style',
    versionedIn: 'sequence_style_versions',
    label: 'Style',
    kind: 'input',
    band: 'bibles',
    summary:
      'The look and motion config snapshotted onto the sequence: derived from the script by the auto style, or picked from the catalog. Every snapshot is a version, so a stale shot names the knob that moved.',
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
    counts: ['Nothing is compared on a switch'],
    ignored: [
      'Switching model: a prompt (visual, motion or music) is checked against the model that wrote it, so the switch applies to the next generation',
    ],
  },
  {
    id: 'imageModel',
    label: 'Image model',
    kind: 'input',
    band: 'settings',
    summary: 'The model that renders sheets and stills.',
    counts: [
      'Model id, for a talent sheet, a library location reference, and an uploaded sheet (which has no model of its own)',
    ],
    ignored: [
      'Switching model: a still or generated sheet is checked against the model that rendered it, so the switch applies to the next render',
    ],
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
    counts: ['Nothing is compared on a switch'],
    ignored: [
      "Switching model: each model keeps its own track, so the switch reads that model's track, or none",
      'An uploaded score, which has no hash to compare',
    ],
  },
  {
    id: 'duration',
    label: 'Shot duration',
    kind: 'input',
    band: 'settings',
    summary: 'Seconds per shot, snapped to the video model.',
    counts: [
      'Seconds (music prompt, and the music track hash as their clamped sum)',
      'Seconds, snapped onto the video model grid, against the clip that rendered',
    ],
    ignored: [
      'Visual and motion prompts',
      'A raise that only covers the bound dialogue audio: both the snapped and the raised length count as unchanged',
    ],
  },
  {
    id: 'startFrameMode',
    label: 'Start-frame mode',
    kind: 'input',
    band: 'settings',
    summary:
      'Animate a rendered still, or render straight from the reference sheets. A shot can override the sequence setting.',
    counts: [
      'On or off, per shot (motion prompt)',
      'On or off, per shot (the clip recorded a still, or none)',
    ],
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
    versionedIn: 'shot_dialogue_versions',
    label: 'Shot dialogue lines',
    kind: 'input',
    band: 'bibles',
    summary:
      "The lines spoken in one shot. Seeded by the shot-list call at the Script stage, then edited on the shot — the script's copy stays as the LLM's seed and is only read for a shot with no row yet. A scene's conversation is its shots in order, then each shot's lines in order, so there is no scene-level list to keep in step.",
    counts: [
      "Voice id + line + tone + TTS model of this shot's voiced lines (the section's sourceKey, the clip's audioSourceKey)",
      "Every line, voiced or not, in the motion prompt's hash and the clip's dialogueKey",
      'Which voice is bound to which line (a bound audio element skips TTS)',
    ],
    ignored: [
      'Speaker renames that do not change which voice is matched',
      'A shot reorder: the speaking order is read from the shots, and every shot keeps the audio cut for its own lines',
      "An edit to another shot's lines: that shot adopts new audio, this one keeps its section",
    ],
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
    ignored: [
      'Talent name',
      'Nothing reports a talent sheet stale: its hash reaches a sequence only through the character sheet',
    ],
    storedAs: 'talent_sheets.inputHash',
  },
  {
    id: 'characterSheet',
    versionedIn: 'character_sheet_variants',
    label: 'Character sheet',
    kind: 'artifact',
    band: 'references',
    summary:
      "Turnaround sheet for a character in this sequence. When cast, it is usually the talent sheet reused; a costumed one is generated only when the role's clothing or features diverge from the talent. A run holds a claim: an edit to anything the sheet reads revokes it, so the run parks its result instead of landing it.",
    counts: [
      'Character bible (age, gender, ethnicity, description, clothing, features, consistency tag)',
      'Talent sheet hash, when cast',
      "The talent's description and default sheet image and look, when cast",
      'Style config',
      'Image model it was rendered with',
    ],
    ignored: [
      'Character name',
      'Personality and movement',
      'Voice-only characters never get one',
    ],
    storedAs:
      'character_sheet_variants.inputHash of the selected version, plus the bible version it read',
  },
  {
    id: 'voice',
    versionedIn: 'character_voice_versions',
    optional: 'when voices are on for a speaking character',
    label: 'Voice',
    kind: 'artifact',
    band: 'references',
    summary:
      'A designed ElevenLabs voice for a speaking character. Bound on the clip like a character sheet on the still — the LLM never sees the id, so a voice change does not rewrite the motion prompt. Every write appends a row and moves the pointer; a row whose ElevenLabs slot has been freed is stamped released and can never be selected again.',
    counts: [
      "Voice id (folds into the recording key, the section's sourceKey, and the clip manifest as audioSourceKey with line, tone and TTS model)",
    ],
    ignored: [
      'Voice description edits ("Generate voice" releases the old one and designs again)',
      'Character bible edits',
    ],
    storedAs:
      'characters.selectedVoiceVersionId → dialogue_recordings.inputHash, shot_dialogue_sections.sourceKey, VideoManifestEntry.audioSourceKey',
  },
  {
    id: 'dialogueRecording',
    optional: 'when voices are on and someone speaks in the scene',
    label: 'Dialogue recording (whole file)',
    kind: 'artifact',
    band: 'references',
    summary:
      'One acted Text to Dialogue call, kept as the whole file it came back as — never joined, never copied per shot. The call speaks the conversation around the shots it was made for, so every turn is a reply to a line the model heard. Append-only with no selection of its own: shots point into it.',
    counts: [
      'The voiced turns that were sent, in speaking order: shot id, voice id, line, tone',
      'TTS model and stability',
    ],
    ignored: [
      'Running line positions (the order already says them)',
      'The wording a fit rewrite actually delivered (kept on the turn as spokenText, so no digest moves)',
      'The voiceId and ttsModel stamped on each turn: a readable copy of what the key already counts, so they move nothing',
    ],
    storedAs:
      'dialogue_recordings.inputHash (the key), dialogue_recordings.turns (voice id and TTS model per turn, readable)',
  },
  {
    id: 'dialogueSection',
    versionedIn: 'shot_dialogue_sections',
    optional: 'when voices are on and someone speaks in the shot',
    label: 'Shot dialogue section',
    kind: 'artifact',
    band: 'references',
    summary:
      "The time range of a recording this shot speaks in. A recording adds a row for every shot it spoke: selected for the shots it was made for, left as an unselected context reading for the rest, so an edit to one shot re-points one shot. The selected row is cut to a file on shots.audioClips, and that clip's id is the row's id.",
    counts: [
      "Voice id + line + tone + TTS model of the shot's authored voiced lines (sourceKey)",
      'Which recording, and from where to where in it',
    ],
    ignored: [
      'A newer recording made for another shot (its reading of this shot waits, unselected, until picked)',
      'The wording a fit rewrite actually delivered (kept as spokenLines; sourceKey keys the authored lines)',
      'The cut file itself: a cache at a key made from the recording id, the range and the pad floor',
    ],
    storedAs: 'shot_dialogue_sections.sourceKey → shots.audioClips',
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
    ignored: [
      'Name',
      'Nothing reports it stale: its hash reaches a sequence only through the location sheet',
    ],
    storedAs: 'location_library.referenceInputHash',
  },
  {
    id: 'locationSheet',
    versionedIn: 'location_sheet_variants',
    label: 'Location sheet',
    kind: 'artifact',
    band: 'references',
    summary:
      'Reference image for a location in this sequence. A run holds a claim: an edit to anything the sheet reads revokes it, so the run parks its result instead of landing it.',
    counts: [
      'Location bible (type, time of day, description, architectural style, key features, colour palette, lighting, ambiance)',
      'Library location reference hash, when linked',
      'Style config',
      'Image model it was rendered with',
    ],
    ignored: [
      'Name',
      {
        gap: "The linked library location's description and reference image, read live: they reach the sheet only through a regenerated library reference",
      },
    ],
    storedAs:
      'location_sheet_variants.inputHash of the selected version, plus the bible version it read',
  },
  // --- Prompts -------------------------------------------------------------
  {
    id: 'visualPrompt',
    versionedIn: 'frame_prompt_versions',
    label: 'Visual prompt',
    kind: 'artifact',
    band: 'prompts',
    summary:
      'The text the still is rendered from. A scene of one shot gets it from the model; every clip of a multi-shot scene has it assembled from the shot spec.',
    counts: [
      'Scene extract, heading, time of day, story beat',
      'Style config',
      'Character, location and element bibles, narrowed to this scene — as cast, so a talent match moves nothing afterwards',
      "The shot's framing and start state, on a multi-shot scene",
      'Aspect ratio',
      'Script model it was written with',
    ],
    ignored: [
      'Duration',
      'Names and titles',
      'The still it produces',
      "A voice-only character's look: heard, never framed, so the still prompt never sees it",
      'The scenes before and after, which the model reads for continuity: hashing them would re-stale three scenes per edit and every scene on a reorder',
    ],
    storedAs: 'frame_prompt_versions.inputHash',
  },
  {
    id: 'motionPrompt',
    versionedIn: 'shot_prompt_versions',
    label: 'Motion prompt',
    kind: 'artifact',
    band: 'prompts',
    summary:
      'The text the clip is rendered from. Assembled from the shot spec on a multi-shot scene, the same as the visual prompt.',
    counts: [
      'Everything the visual prompt counts',
      'Character personality and movement',
      "The shot's own lines, in place of the script's",
      'The rendered still it was shown (start-frame mode)',
      'Start-frame mode',
      'Which characters are voice-only',
    ],
    ignored: [
      'Duration',
      'Names and titles',
      'Voice ids (they bind on the clip, like sheets on the still)',
      'Which voice element is bound to a line',
      'The scenes before and after, as for the visual prompt',
    ],
    storedAs: 'shot_prompt_versions.inputHash',
  },
  {
    id: 'musicPrompt',
    versionedIn: 'sequence_music_prompt_versions',
    label: 'Music prompt',
    kind: 'artifact',
    band: 'prompts',
    summary: 'One prompt for the whole sequence.',
    counts: [
      'Per scene: story beat, heading, time of day',
      "Per scene: its shots' durations, summed",
      'Script model',
    ],
    ignored: [
      'Scene titles',
      'Scene ids (order is the key)',
      'The visual prompt (the brief never reads it, #1783)',
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
    storedAs: 'frame_variants.inputHash',
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
      'Bound dialogue-audio identity (audioSourceKey: voice id + line + tone + TTS model)',
      'Every line its prompt quoted, voiced or not (dialogueKey), on a model with audio',
      'Which dialogue sections its audio was cut from (audioClipIds, against the clip ids the shot holds now)',
      'Every reference it was sent, as the sheet version or media URL that was current then (referenceKeys)',
      'The length it was rendered at, snapped onto the model grid on both sides',
    ],
    ignored: [
      'Video model (a different model is a different segment, not a stale one)',
      'Resolution (stamped on the version so a 4K re-roll stays legible, never compared)',
      'Rows from before the stamp existed: an absent field is unknown, never stale',
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
    counts: [
      'Selected music prompt text and tags',
      'Requested length: the shot durations summed, clamped to the model ceiling',
      'Music model',
    ],
    ignored: [
      'An uploaded score, which stores no hash and so can never read stale',
    ],
    storedAs: 'sequence_music_variants.inputHash',
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
    {
      from: 'analysisModel',
      to,
      tracking: 'untracked' as const,
      note: 'checked against the model that wrote the prompt; a switch applies to the next generation',
    },
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
    note: "the shot-list call assigns every spoken line to a shot and seeds that shot's lines with it",
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
    from: 'talent',
    to: 'characterSheet',
    tracking: 'hash',
    note: "the talent's description and default sheet image and look, read by the sheet prompt",
  },
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
    gap: true,
    note: 'a library voice is copied onto the character at cast, not designed — and redesigning the talent voice later reaches nothing, since talent voices have no version history',
  },
  {
    from: 'imageModel',
    to: 'characterSheet',
    tracking: 'untracked',
    note: 'checked against the model that rendered the selected version; only an uploaded sheet follows a switch',
  },
  {
    from: 'dialogue',
    to: 'dialogueRecording',
    tracking: 'hash',
    note: 'the voiced turns that were sent, in speaking order, with the shot each belongs to',
  },
  {
    from: 'voice',
    to: 'dialogueRecording',
    tracking: 'hash',
    note: 'the voice speaking each turn is part of the recording key',
  },
  {
    from: 'dialogue',
    to: 'dialogueSection',
    tracking: 'hash',
    note: "sourceKey keys this shot's own voiced lines; only a shot whose key no longer matches adopts new audio",
  },
  {
    from: 'voice',
    to: 'dialogueSection',
    tracking: 'hash',
    note: 'the voice id is part of sourceKey, so a new voice re-records the shots that voice speaks in',
  },
  {
    from: 'dialogueRecording',
    to: 'dialogueSection',
    tracking: 'pointer',
    note: 'a section is a time range of one recording; a re-record appends a recording and re-points only the shots it was made for',
  },
  { from: 'libraryLocation', to: 'libraryLocationReference', tracking: 'hash' },
  { from: 'style', to: 'libraryLocationReference', tracking: 'hash' },
  { from: 'imageModel', to: 'libraryLocationReference', tracking: 'hash' },
  {
    from: 'location',
    to: 'locationSheet',
    tracking: 'hash',
    note: 'every bible field the sheet prompt reads',
  },
  { from: 'libraryLocationReference', to: 'locationSheet', tracking: 'hash' },
  { from: 'style', to: 'locationSheet', tracking: 'hash' },
  {
    from: 'imageModel',
    to: 'locationSheet',
    tracking: 'untracked',
    note: 'checked against the model that rendered the selected version; only an uploaded sheet follows a switch',
  },
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
    from: 'dialogue',
    to: 'motionPrompt',
    tracking: 'hash',
    note: "the shot's lines replace the script's in what the LLM reads and the hash covers",
  },
  {
    from: 'startFrameMode',
    to: 'motionPrompt',
    tracking: 'hash',
    note: 'each mode uses a different prompt template',
  },
  { from: 'script', to: 'musicPrompt', tracking: 'hash' },
  {
    from: 'duration',
    to: 'musicPrompt',
    tracking: 'hash',
    note: "each scene's shot durations, summed",
  },
  {
    from: 'analysisModel',
    to: 'musicPrompt',
    tracking: 'untracked',
    note: 'checked against the model that wrote the prompt; a switch applies to the next generation',
  },
  // Renders
  {
    from: 'visualPrompt',
    to: 'still',
    tracking: 'hash',
    note: 'the selected prompt text',
  },
  {
    from: 'imageModel',
    to: 'still',
    tracking: 'untracked',
    note: 'checked against the model that rendered the still; a switch applies to the next render',
  },
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
    tracking: 'pointer',
    note: 'the sheets ride as video references in both modes; the manifest stamps the selected version id it was sent (referenceKeys)',
  },
  {
    from: 'locationSheet',
    to: 'clip',
    tracking: 'pointer',
    mode: 'reference-only',
    note: 'only reference-only sends the location sheet to the video model; the manifest stamps the version it was sent',
  },
  {
    from: 'startFrameMode',
    to: 'clip',
    tracking: 'hash',
    note: 'a start-frame render records its still and a reference-only one records none, so switching a shot either way flags its clip',
  },
  {
    from: 'duration',
    to: 'clip',
    tracking: 'hash',
    note: 'the manifest length against the live duration, each snapped onto the model grid, so a pipeline re-snap no longer flags every clip (#767)',
  },
  {
    from: 'dialogue',
    to: 'clip',
    tracking: 'hash',
    note: 'every line the prompt quoted folds into dialogueKey, and voiced lines into audioSourceKey, on the manifest',
  },
  {
    from: 'voice',
    to: 'clip',
    tracking: 'hash',
    note: 'the voice id folds into audioSourceKey; the LLM never sees it',
  },
  {
    from: 'dialogueSection',
    to: 'clip',
    tracking: 'pointer',
    note: "the manifest records the clip id (audioClipIds), which is the section's id, so picking another reading of the same lines re-stales only that shot's clip",
  },
  {
    from: 'element',
    to: 'clip',
    tracking: 'hash',
    note: 'its media URL is stamped in referenceKeys, so a re-uploaded image, audio or video clip flags the render',
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
    note: "each model keeps its own track; a switch reads that model's track, or none",
  },
  {
    from: 'duration',
    to: 'musicTrack',
    tracking: 'hash',
    note: 'the shot durations summed and clamped are the length the track was billed for',
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
    tracking: 'hash',
    note: 'the selected prompt text and tags are in the track hash; Update all can regenerate the track on its own',
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
