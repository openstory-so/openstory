/**
 * Staleness matrix (#1108, rewritten for #1787). Each row is one user
 * mutation and the verdict every artifact downstream of it shows, asserted
 * through the functions the product reads — never by comparing hashes:
 *
 *   - still, visual prompt, motion prompt: `computeShotStaleness`
 *   - clip: `assembleSequenceSegments` → `isSelectedVersionStale`
 *   - character / location sheet: `readReferenceStaleness`
 *   - music prompt and track: `readMusicPromptStaleness`
 *
 * An artifact is "stamped" by running the same verdict over the starting
 * state and keeping the live hashes it computed, so a row says only what a
 * mutation moves. That each WRITER stamps what verify recomputes is pinned
 * next to the writer; the round trips are listed at the bottom.
 *
 * No row switches a model. No verdict reads the sequence's image, video or
 * music model: a still, clip or sheet is verified against its own model, so a
 * switch applies to the next render and never stales the last one (#1785).
 * The analysis model is the one a prompt pins, so a switch does not stale it
 * either (rows below).
 */

import { describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  CharacterLook,
  CharacterWithSheet,
  Frame,
  FrameVariant,
  SequenceElement,
  SequenceLocationWithReference,
  Shot,
  StyleConfig,
} from '@/platform/server/db/schema';
import type { MotionDialogue, Scene } from '@/shots/scene-analysis.schema';
import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { liveReferenceIdentity } from '@/motion/reference-provenance';
import { assembleSequenceSegments } from '@/shots/scene-segments';
import { dialogueLinesKey } from '@/shots/shot-dialogue';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import { resolveShotReferences } from '@/shots/scene-matching';
import {
  readLookSheetStaleness,
  readReferenceStaleness,
} from '@/cast/server/production-staleness';
import { buildRegenerateCharacterSheetPayload } from '@/cast/server/sheets/character-sheet-trigger';
import { legacyStylingParts } from '@/cast/server/bibles-from-scoped';
import {
  buildRegenerateLocationSheetPayload,
  toLocationMetadata,
} from '@/cast/server/sheets/location-sheet-trigger';
import { buildLocationInsert } from '@/cast/server/workflows/cast-records';
import {
  computeCharacterSheetHashFromDtoBefore2065,
  computeLocationSheetHashFromDto,
  computeStyleConfigHash,
} from '@/cast/server/workflows/sheet-snapshots';
import { readMusicPromptStaleness } from '@/audio/server/music-staleness';
import { musicSceneSummariesFromRows } from '@/audio/server/workflows/music-scene-summaries';
import {
  computeMotionPromptInputHashV4,
  computeMusicPromptInputHash,
  computeSequenceMusicInputHash,
  computeVisualPromptInputHashV4,
} from '@/shots/input-hash';
import type { LegacyStylingByCharacter } from '@/shots/input-hash';
import { effectiveStyling } from '@/cast/character-looks';
import { loadNarrowShotPromptContext } from './prompt-context';
import { computeShotStaleness } from './shot-staleness';
import { asStub } from '@/test/as-stub';

const ANALYSIS_MODEL = 'anthropic/claude-haiku-4.5';
/** Takes dialogue audio and reference images, so both reach its manifest. */
const VIDEO_MODEL = 'kling_v3_pro';
const AT = new Date('2026-01-01T00:00:00Z');

const STYLE: StyleConfig = {
  version: 2,
  look: {
    mood: 'neutral',
    artStyle: 'cinematic',
    lighting: 'natural',
    colorPalette: ['neutral'],
    colorGrading: 'neutral',
  },
  motion: { camera: 'static' },
  references: [],
};

type CharacterRow = CharacterWithSheet;
/**
 * A character as a scoped read returns it (#2015): wearing its default look,
 * whose id is the character's. `withLooks` lists that look the way the read
 * does, from the row's own fields, plus any others a test adds.
 */
const defaultLookOf = (c: CharacterRow): CharacterLook =>
  asStub<CharacterLook>({
    id: c.id,
    characterId: c.id,
    isDefault: true,
    deletedAt: null,
    lookVersionId: `lookver-${c.id}`,
    name: 'Default',
    clothing: c.standardClothing,
    styling: c.styling,
    storedStyling: c.styling,
    sheetStatus: c.sheetStatus,
    sheetImageUrl: c.sheetImageUrl,
    sheetInputHash: c.sheetInputHash,
    selectedSheetVersionId: c.selectedSheetVersionId,
  });
const withLooks = (c: CharacterRow, others: CharacterLook[] = []) => ({
  ...c,
  looks: [defaultLookOf(c), ...others],
});
const character = (fields: Partial<CharacterRow>): CharacterRow =>
  asStub<CharacterRow>({
    sequenceId: 'seq',
    lookId: fields.id,
    lookName: 'Default',
    styling: null,
    looks: [],
    age: '30',
    gender: null,
    ethnicity: null,
    standardClothing: null,
    legacyDistinguishingFeatures: null,
    personality: null,
    movement: null,
    voiceDescription: null,
    voiceOnly: false,
    isPerson: true,
    rendering: 'Photoreal live action',
    talentId: null,
    sheetStatus: 'completed',
    selectedBibleVersionId: null,
    deletedAt: null,
    updatedAt: AT,
    sheetGeneratedAt: AT,
    ...fields,
  });

const ALICE = character({
  id: 'c-alice',
  characterId: 'alice',
  name: 'Alice',
  physicalDescription: 'tall, brown hair',
  consistencyTag: 'alice_tag',
  selectedSheetVersionId: 'csv-alice-1',
  sheetInputHash: 'alice-sheet-hash',
  sheetImageUrl: '/r2/alice.png',
});
const BOB = character({
  id: 'c-bob',
  characterId: 'bob',
  name: 'Bob',
  physicalDescription: 'short, bald',
  consistencyTag: 'bob_tag',
  selectedSheetVersionId: 'csv-bob-1',
  sheetInputHash: 'bob-sheet-hash',
  sheetImageUrl: '/r2/bob.png',
});

const BEACH = asStub<SequenceLocationWithReference>({
  id: 'l-beach',
  sequenceId: 'seq',
  locationId: 'beach',
  name: 'Beach',
  type: 'exterior',
  description: 'white sand',
  architecturalStyle: null,
  keyFeatures: null,
  ambiance: null,
  consistencyTag: 'beach_tag',
  firstMentionSceneId: 'scene-1',
  firstMentionText: 'BEACH',
  firstMentionLine: 1,
  libraryLocationId: null,
  referenceStatus: 'completed',
  selectedReferenceVersionId: 'lsv-beach-1',
  selectedBibleVersionId: null,
  referenceInputHash: 'beach-ref-hash',
  referenceImageUrl: '/r2/beach.png',
  referenceGeneratedAt: AT,
  deletedAt: null,
  updatedAt: AT,
});

const LANTERN = asStub<SequenceElement>({
  id: 'e-lantern',
  sequenceId: 'seq',
  token: 'LANTERN',
  description: 'brass storm lantern',
  consistencyTag: 'lantern_tag',
  firstMentionSceneId: 'scene-1',
  firstMentionText: 'LANTERN',
  firstMentionLine: 1,
  imageUrl: '/r2/lantern-1.png',
  updatedAt: AT,
});

const SCENE: Scene = {
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: {
    extract: 'ALICE walks the beach holding the LANTERN.',
    dialogue: [],
  },
  metadata: {
    title: 'Beach walk',
    durationSeconds: 5,
    location: 'Beach',
    timeOfDay: 'day',
    storyBeat: 'setup',
  },
  continuity: {
    characterTags: ['alice'],
    environmentTag: 'beach',
    elementTags: ['LANTERN'],
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
};

/** Everything the shot's four artifacts are verified against. */
type World = {
  sequence: {
    id: string;
    styleId: string | null;
    styleConfig: StyleConfig;
    aspectRatio: '16:9' | '9:16';
    analysisModel: string;
    generateStartFrames: boolean;
    status: 'completed';
  };
  shot: { useStartFrame: boolean | null };
  scene: Scene;
  characters: CharacterRow[];
  locations: SequenceLocationWithReference[];
  elements: SequenceElement[];
  visualPrompt: string;
  motionPrompt: string;
  still: { id: string; url: string };
  motionVersionId: string;
  durationMs: number;
  dialogue: MotionDialogue;
};

const BASE: World = {
  sequence: {
    id: 'seq',
    styleId: null,
    styleConfig: STYLE,
    aspectRatio: '16:9',
    analysisModel: ANALYSIS_MODEL,
    generateStartFrames: true,
    status: 'completed',
  },
  shot: { useStartFrame: null },
  scene: SCENE,
  characters: [ALICE, BOB],
  locations: [BEACH],
  elements: [LANTERN],
  visualPrompt: 'Alice walks along the beach at dawn, holding the LANTERN.',
  motionPrompt: 'Alice lifts the LANTERN and walks on.',
  still: { id: 'still-1', url: '/r2/still-1.png' },
  motionVersionId: 'motion-1',
  durationMs: 5000,
  dialogue: {
    presence: true,
    lines: [{ character: 'Alice', line: 'Stay close.', tone: '' }],
  },
};

type Stamps = { still: string; visualPrompt: string; motionPrompt: string };

/**
 * The prompt rows as D1 holds them: selected, hashed, and pinning the
 * analysis model they were written with.
 */
/** A character bible version, as the voice-only verify reads it. */
type VoiceVersion = {
  characterId: string;
  voiceOnly: boolean;
  createdAt: Date;
};

function shotDb(
  world: World,
  stamps: Stamps,
  characterVersions: VoiceVersion[] = []
) {
  const none = () => Promise.resolve(null);
  const empty = () => Promise.resolve([]);
  return asStub<ScopedDb>({
    framePromptVersions: {
      getSelected: () =>
        Promise.resolve({
          text: world.visualPrompt,
          inputHash: stamps.visualPrompt,
          createdAt: AT,
        }),
      getLatest: () => Promise.resolve({ analysisModel: ANALYSIS_MODEL }),
      getLatestWithInputHash: none,
      getLivePending: none,
      getByIdForFrame: none,
    },
    shotPromptVersions: {
      getSelectedMotion: () =>
        Promise.resolve({
          text: world.motionPrompt,
          inputHash: stamps.motionPrompt,
          createdAt: AT,
        }),
      getLatest: () => Promise.resolve({ analysisModel: ANALYSIS_MODEL }),
      getLatestWithInputHash: none,
      getLivePending: none,
    },
    // No spec: the matrix pins prompt staleness, not spec currency (#1923).
    shotSpecVersions: { getSelected: none },
    frameVariants: { listLiveClaims: empty },
    // The stale-cause hints read these; the legacy-digest verify reads the
    // character versions for a moved voice-only flag (#1787).
    characters: {
      listBibleVersionsBySequence: () => Promise.resolve(characterVersions),
    },
    characterLooks: { listVersionsBySequence: empty },
    sequenceLocations: { listBibleVersionsBySequence: empty },
    sceneScriptVersions: { listBySequence: empty, getSelected: none },
    scenes: { getById: none },
    sequences: { listStyleVersions: empty },
    shotDialogue: { getSelectedBySequence: empty },
    sequenceEvents: { listByTarget: empty, listPinMoves: empty },
  });
}

async function shotVerdicts(
  world: World,
  stamps: Stamps,
  characterVersions?: VoiceVersion[]
) {
  return computeShotStaleness({
    scopedDb: shotDb(world, stamps, characterVersions),
    sequence: world.sequence,
    shot: asStub<Shot>({ id: 'shot-1', sceneId: null, ...world.shot }),
    frame: asStub<Frame>({ id: 'frame-1' }),
    selectedImage: asStub<FrameVariant>({
      ...world.still,
      model: DEFAULT_IMAGE_MODEL,
      inputHash: stamps.still,
      generatedAt: AT,
      createdAt: AT,
    }),
    scene: world.scene,
    refs: {
      characters: world.characters,
      locations: world.locations,
      elements: world.elements,
      style: null,
    },
    dialogue: { dialogue: world.dialogue, onNode: true },
  });
}

/** Stamp every shot artifact from `world`, as its generation would have. */
async function stampShot(world: World = BASE): Promise<Stamps> {
  const { liveHashes } = await shotVerdicts(world, {
    still: 'unstamped',
    visualPrompt: 'unstamped',
    motionPrompt: 'unstamped',
  });
  const { thumbnail, visualPrompt, motionPrompt } = liveHashes;
  if (!thumbnail || !visualPrompt || !motionPrompt) {
    throw new Error('test setup: a base hash did not compute');
  }
  return { still: thumbnail, visualPrompt, motionPrompt };
}

/** The prompt context the verify builds for `world`'s shot, per channel. */
async function promptContext(world: World, channel: 'visual' | 'motion') {
  const referenceOnly = rendersReferenceOnly(world.shot, world.sequence);
  const { shot } = await loadNarrowShotPromptContext({
    scopedDb: asStub<ScopedDb>({}),
    sequence: { ...world.sequence, referenceOnly },
    scene: world.scene,
    analysisModelOverride: ANALYSIS_MODEL,
    startingFrameImageUrl: null,
    refs: {
      characters: world.characters,
      locations: world.locations,
      elements: world.elements,
      style: null,
    },
    view:
      channel === 'visual'
        ? { channel, prompt: world.visualPrompt }
        : { channel, prompt: world.motionPrompt, referenceOnly },
  });
  return shot;
}

type LegacyPromptKind = Parameters<typeof computeVisualPromptInputHashV4>[2];

/** The visual prompt's digest in a shape the hasher stamped before now. */
async function legacyVisualStamp(world: World, kind: LegacyPromptKind) {
  const ctx = await promptContext(world, 'visual');
  return computeVisualPromptInputHashV4(
    { ...ctx, spec: null },
    ctx.legacyStyling,
    kind
  );
}

/**
 * Stamp `world`'s shot as the hasher did before #2065: the prompts in the
 * `pre-2065` shape. The still never read the bible.
 *
 * `parts` is what the old hasher read for each character, by script id,
 * WRITTEN BY HAND in the test: the features column and the worn look's own
 * styling column. Never the context's `legacyStyling`, which is the mapping
 * verify itself uses; a stamp built from it would agree with a wrong mapping.
 */
async function stampShotBefore2065(
  world: World,
  parts: LegacyStylingByCharacter
): Promise<Stamps> {
  const visual = await promptContext(world, 'visual');
  const motion = await promptContext(world, 'motion');
  return {
    still: (await stampShot(world)).still,
    visualPrompt: await computeVisualPromptInputHashV4(
      { ...visual, spec: null },
      parts,
      'pre-2065'
    ),
    motionPrompt: await computeMotionPromptInputHashV4(
      { ...motion, dialogue: world.dialogue, spec: null },
      parts,
      'pre-2065'
    ),
  };
}

/** The clip rendered from `BASE`, sent Alice's sheet and the lantern. */
function stampClip() {
  const identity = liveReferenceIdentity(BASE);
  const referenceKeys = ['character:c-alice', 'element:e-lantern'].map(
    (key) => identity.get(key) ?? ''
  );
  return {
    id: 'clip-1',
    renderSegmentId: 'segment-1',
    model: VIDEO_MODEL,
    resolution: null,
    status: 'completed' as const,
    url: '/r2/clip-1.mp4',
    createdAt: AT,
    draftTaskId: null,
    manifest: [
      {
        shotId: 'shot-1',
        motionPromptVersionId: BASE.motionVersionId,
        frameVersionId: BASE.still.id,
        usesStartFrame: true,
        durationMs: BASE.durationMs,
        audioClipIds: [],
        audioSourceKey: null,
        dialogueKey: dialogueLinesKey(BASE.dialogue),
        referenceKeys,
      },
    ],
  };
}

function clipIsStale(world: World): boolean {
  const [segment] = assembleSequenceSegments({
    segments: [
      { id: 'segment-1', sceneId: 'scene-1', selectedVideoVersionId: 'clip-1' },
    ],
    versions: [stampClip()],
    shots: [
      {
        id: 'shot-1',
        renderSegmentId: 'segment-1',
        selectedMotionPromptVersionId: world.motionVersionId,
        audioClips: null,
        durationMs: world.durationMs,
        rendersReferenceOnly: rendersReferenceOnly(world.shot, world.sequence),
      },
    ],
    frames: [
      {
        shotId: 'shot-1',
        role: 'first',
        selectedImageVersionId: world.still.id,
      },
    ],
    live: {
      audioSourceKeyByShot: new Map(),
      dialogueKeyByShot: new Map([
        ['shot-1', dialogueLinesKey(world.dialogue)],
      ]),
      referenceIdentity: liveReferenceIdentity(world),
      referencedEntitiesByShot: new Map([['shot-1', wouldBeSent(world)]]),
    },
  });
  if (!segment) throw new Error('test setup: no segment');
  return segment.stale;
}

/** What a render of shot-1 would be sent now, as `loadLiveShotInputs` resolves it. */
function wouldBeSent(world: World): ReadonlySet<string> {
  const sent = resolveShotReferences(
    {
      characters: world.characters,
      locations: world.locations,
      elements: world.elements,
    },
    {
      characterTags: world.scene.continuity?.characterTags,
      characterLooks: world.scene.continuity?.characterLooks,
      environmentTag: world.scene.continuity?.environmentTag,
      sceneLocation: world.scene.metadata?.location,
      elementTags: world.scene.continuity?.elementTags,
      sceneExtract: world.scene.originalScript.extract,
    },
    {
      channel: 'motion',
      prompt: world.motionPrompt,
      referenceOnly: rendersReferenceOnly(world.shot, world.sequence),
    }
  );
  return new Set([
    ...sent.characters.map((c) => `character:${c.id}`),
    ...sent.locations.map((l) => `location:${l.id}`),
    ...sent.elements.map((e) => `element:${e.id}`),
  ]);
}

type ShotArtifact = 'still' | 'visualPrompt' | 'motionPrompt' | 'clip';
type ShotRow = {
  mutation: string;
  apply: (w: World) => World;
  /** Every artifact not listed must read fresh. */
  stale: ShotArtifact[];
};

const withCharacter = (
  w: World,
  id: string,
  fields: Partial<CharacterRow>
): World => ({
  ...w,
  characters: w.characters.map((c) => (c.id === id ? { ...c, ...fields } : c)),
});
const withLocation = (
  w: World,
  fields: Partial<SequenceLocationWithReference>
): World => ({
  ...w,
  locations: w.locations.map((l) => ({ ...l, ...fields })),
});
const withElement = (w: World, fields: Partial<SequenceElement>): World => ({
  ...w,
  elements: w.elements.map((e) => ({ ...e, ...fields })),
});
const withMetadata = (
  w: World,
  fields: Partial<NonNullable<Scene['metadata']>>
): World => {
  const metadata = w.scene.metadata;
  if (!metadata) throw new Error('test setup: scene has no metadata');
  return { ...w, scene: { ...w.scene, metadata: { ...metadata, ...fields } } };
};
const withContinuity = (
  w: World,
  fields: Partial<NonNullable<Scene['continuity']>>
): World => {
  const continuity = w.scene.continuity;
  if (!continuity) throw new Error('test setup: scene has no continuity');
  return {
    ...w,
    scene: { ...w.scene, continuity: { ...continuity, ...fields } },
  };
};

const SHOT_MATRIX: ShotRow[] = [
  // --- the shot's own chain ------------------------------------------------
  {
    mutation: 'visual prompt edited',
    apply: (w) => ({ ...w, visualPrompt: 'Alice runs along the beach.' }),
    // The clip follows the still, not the prompt: it goes stale when a new
    // still is selected.
    stale: ['still'],
  },
  {
    mutation: 'new still selected (regenerated or uploaded)',
    apply: (w) => ({
      ...w,
      still: { id: 'still-2', url: '/r2/still-2.png' },
    }),
    // The motion prompt is built from the spec, not the still (#1923).
    stale: ['clip'],
  },
  {
    mutation: 'new motion prompt selected',
    apply: (w) => ({ ...w, motionVersionId: 'motion-2' }),
    stale: ['clip'],
  },
  {
    mutation: 'shot line edited (#1784)',
    apply: (w) => ({
      ...w,
      dialogue: {
        presence: true,
        lines: [{ character: 'Alice', line: 'Stay down.', tone: '' }],
      },
    }),
    stale: ['motionPrompt', 'clip'],
  },
  {
    mutation: 'shot duration changed',
    apply: (w) => ({ ...w, durationMs: 10_000 }),
    stale: ['clip'],
  },
  {
    mutation: 'shot switched to reference-only on a start-frame sequence',
    apply: (w) => ({ ...w, shot: { useStartFrame: false } }),
    // The motion prompt loses its still; the clip was sent one.
    stale: ['motionPrompt', 'clip'],
  },
  // --- sequence settings ---------------------------------------------------
  {
    mutation: 'style lighting changed',
    apply: (w) => ({
      ...w,
      sequence: {
        ...w.sequence,
        styleConfig: {
          ...STYLE,
          look: { ...STYLE.look, lighting: 'hard noon sun' },
        },
      },
    }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'aspect ratio changed',
    apply: (w) => ({
      ...w,
      sequence: { ...w.sequence, aspectRatio: '9:16' },
    }),
    stale: ['still', 'visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'analysis model switched (prompts pin their own, #1785)',
    apply: (w) => ({
      ...w,
      sequence: { ...w.sequence, analysisModel: 'openai/gpt-5' },
    }),
    stale: [],
  },
  // --- scene ---------------------------------------------------------------
  {
    mutation: 'scene script edited',
    apply: (w) => ({
      ...w,
      scene: {
        ...w.scene,
        originalScript: {
          extract: 'ALICE sprints down the beach with the LANTERN.',
          dialogue: [],
        },
      },
    }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'scene time of day edited',
    apply: (w) => withMetadata(w, { timeOfDay: 'night' }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'scene story beat edited',
    apply: (w) => withMetadata(w, { storyBeat: 'climax' }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'scene title renamed (a label)',
    apply: (w) => withMetadata(w, { title: 'Dawn walk' }),
    stale: [],
  },
  {
    mutation: 'scene duration edited (a video parameter)',
    apply: (w) => withMetadata(w, { durationSeconds: 42 }),
    stale: [],
  },
  {
    mutation: 'scene moved to another position',
    apply: (w) => ({ ...w, scene: { ...w.scene, sceneNumber: 7 } }),
    stale: [],
  },
  {
    mutation: 'Bob tagged into the scene continuity',
    apply: (w) => withContinuity(w, { characterTags: ['alice', 'bob'] }),
    // Both prompts are written and neither names Bob: the tags no longer
    // pick anyone (#2012). The still attaches what its prompt names (#1432).
    stale: [],
  },
  // --- characters ----------------------------------------------------------
  {
    mutation: "Alice's description edited",
    apply: (w) =>
      withCharacter(w, 'c-alice', { physicalDescription: 'short, red hair' }),
    // Her sheet goes stale (sheet matrix); the still follows when it lands.
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: "Alice's personality edited",
    apply: (w) => withCharacter(w, 'c-alice', { personality: 'restless' }),
    stale: ['motionPrompt'],
  },
  {
    mutation: 'Alice renamed (a label)',
    apply: (w) => withCharacter(w, 'c-alice', { name: 'Alicia' }),
    stale: [],
  },
  {
    mutation: "Alice's consistency tag edited",
    apply: (w) => withCharacter(w, 'c-alice', { consistencyTag: 'alice_v2' }),
    stale: [],
  },
  {
    mutation: "Alice's sheet regenerated and selected",
    apply: (w) =>
      withCharacter(w, 'c-alice', { selectedSheetVersionId: 'csv-alice-2' }),
    stale: ['still', 'clip'],
  },
  {
    mutation: 'Alice deleted',
    apply: (w) => ({
      ...w,
      characters: w.characters.filter((c) => c.id !== 'c-alice'),
    }),
    stale: ['still', 'visualPrompt', 'motionPrompt', 'clip'],
  },
  {
    // A restore brings back the same row, so every input is as it was.
    mutation: 'Alice deleted and restored',
    apply: (w) => w,
    stale: [],
  },
  {
    mutation: 'Bob (not in the scene) edited',
    apply: (w) =>
      withCharacter(w, 'c-bob', {
        physicalDescription: 'rewritten',
        selectedSheetVersionId: 'csv-bob-2',
      }),
    stale: [],
  },
  // --- location ------------------------------------------------------------
  {
    mutation: 'location description edited',
    apply: (w) => withLocation(w, { description: 'black volcanic sand' }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'location fixtures edited',
    apply: (w) => withLocation(w, { keyFeatures: 'neon sign' }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'location renamed (a label)',
    apply: (w) => withLocation(w, { name: 'The Shore' }),
    stale: [],
  },
  {
    mutation: 'location sheet regenerated and selected',
    apply: (w) => withLocation(w, { selectedReferenceVersionId: 'lsv-2' }),
    // The clip was sent only Alice's sheet and the lantern.
    stale: ['still'],
  },
  {
    mutation: 'location deleted',
    apply: (w) => ({ ...w, locations: [] }),
    stale: ['still', 'visualPrompt', 'motionPrompt'],
  },
  // --- element -------------------------------------------------------------
  {
    mutation: 'element description edited',
    apply: (w) => withElement(w, { description: 'rusty oil lamp' }),
    stale: ['visualPrompt', 'motionPrompt'],
  },
  {
    mutation: 'element image replaced',
    apply: (w) => withElement(w, { imageUrl: '/r2/lantern-2.png' }),
    stale: ['still', 'clip'],
  },
  {
    mutation: 'element consistency tag edited',
    apply: (w) => withElement(w, { consistencyTag: 'lamp_tag' }),
    stale: [],
  },
  {
    // `cascadeRename` rewrites the script and the prompts with the new
    // token, appending `renamed` rows the selections move to.
    mutation: 'element token renamed (script and prompts rewritten)',
    apply: (w) => {
      const renamed = withContinuity(withElement(w, { token: 'LAMP' }), {
        elementTags: ['LAMP'],
      });
      return {
        ...renamed,
        scene: {
          ...renamed.scene,
          originalScript: {
            extract: 'ALICE walks the beach holding the LAMP.',
            dialogue: [],
          },
        },
        visualPrompt: 'Alice walks along the beach at dawn, holding the LAMP.',
        motionVersionId: 'motion-renamed',
      };
    },
    // The token reaches the model, so what names it reads stale; the clip
    // follows its motion-prompt pointer to the renamed row (#1786).
    stale: ['still', 'visualPrompt', 'motionPrompt', 'clip'],
  },
  {
    mutation: 'motion prompt edited after a token rename',
    apply: (w) => ({ ...w, motionVersionId: 'motion-edit' }),
    stale: ['clip'],
  },
  {
    mutation: 'element deleted',
    apply: (w) => ({ ...w, elements: [] }),
    stale: ['still', 'visualPrompt', 'motionPrompt', 'clip'],
  },
  {
    mutation: 'element deleted and restored',
    apply: (w) => w,
    stale: [],
  },
];

describe('staleness matrix — a shot and its clip', () => {
  it('reads every artifact fresh against the state it was stamped from', async () => {
    const stamps = await stampShot();
    expect(await shotVerdicts(BASE, stamps)).toMatchObject({
      thumbnail: 'fresh',
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
    expect(clipIsStale(BASE)).toBe(false);
  });

  // Every digest before the current shape ignores the voice-only flag, and
  // for a cast with no voice-only character it equals today's stamp. So a
  // legacy digest is trusted only while no flag moved since the stamp.
  const BEFORE = new Date(AT.getTime() - 60_000);
  const LATER = new Date(AT.getTime() + 60_000);
  const aliceVoiceOnly = withCharacter(BASE, 'c-alice', { voiceOnly: true });

  it('Alice made voice-only → visual and motion prompts stale', async () => {
    const stamps = await stampShot();
    const verdicts = await shotVerdicts(aliceVoiceOnly, stamps, [
      { characterId: 'c-alice', voiceOnly: false, createdAt: BEFORE },
      { characterId: 'c-alice', voiceOnly: true, createdAt: LATER },
    ]);
    expect(verdicts).toMatchObject({
      visualPrompt: 'stale',
      motionPrompt: 'stale',
    });
  });

  it('a pre-#1785 stamp of a voice-only Alice stays fresh on deploy', async () => {
    // The pre-#1785 digest of a voice-only Alice is the digest of a voiced
    // one: that shape never read the flag. Visual only: an old motion stamp
    // also carried the still URL, which is not this row's subject.
    const stamps = {
      ...(await stampShot()),
      visualPrompt: await legacyVisualStamp(BASE, 'v5-voiced'),
    };
    const verdicts = await shotVerdicts(aliceVoiceOnly, stamps, [
      { characterId: 'c-alice', voiceOnly: true, createdAt: BEFORE },
    ]);
    expect(verdicts).toMatchObject({ visualPrompt: 'fresh' });
  });

  it.each(SHOT_MATRIX)('$mutation → stale: $stale', async (row) => {
    const stamps = await stampShot();
    const world = row.apply(BASE);
    const verdicts = await shotVerdicts(world, stamps);
    const expected = (artifact: ShotArtifact) =>
      row.stale.includes(artifact) ? 'stale' : 'fresh';
    expect({
      still: verdicts.thumbnail,
      visualPrompt: verdicts.visualPrompt,
      motionPrompt: verdicts.motionPrompt,
      clip: clipIsStale(world) ? 'stale' : 'fresh',
    }).toEqual({
      still: expected('still'),
      visualPrompt: expected('visualPrompt'),
      motionPrompt: expected('motionPrompt'),
      clip: expected('clip'),
    });
  });
});

// ---------------------------------------------------------------------------
// Looks (#2015) — a scene dresses each character in one look. The still
// follows that look's sheet and the prompts its clothing, so a look edit
// reaches only the scenes that wear it.
// ---------------------------------------------------------------------------

const GALA = asStub<CharacterLook>({
  id: 'look-gala',
  characterId: 'c-alice',
  isDefault: false,
  deletedAt: null,
  lookVersionId: 'lookver-gala-1',
  name: 'Gala gown',
  clothing: 'red gown',
  styling: null,
  storedStyling: null,
  sheetStatus: 'completed',
  sheetImageUrl: '/r2/alice-gala.png',
  sheetInputHash: 'alice-gala-sheet-hash',
  selectedSheetVersionId: 'csv-alice-gala-1',
});
/** Alice owns a gala look; whether a scene wears it is the scene's pick. */
const withGala = (w: World, gala: CharacterLook = GALA): World => ({
  ...w,
  characters: w.characters.map((c) =>
    c.id === 'c-alice' ? withLooks(c, [gala]) : c
  ),
});
const inGala = (w: World): World =>
  withContinuity(w, { characterLooks: { alice: 'look-gala' } });

describe('staleness matrix — looks (#2015)', () => {
  const verdictsOf = async (world: World, stamps: Stamps) => {
    const v = await shotVerdicts(world, stamps);
    return {
      still: v.thumbnail,
      visualPrompt: v.visualPrompt,
      motionPrompt: v.motionPrompt,
    };
  };
  const FRESH = {
    still: 'fresh',
    visualPrompt: 'fresh',
    motionPrompt: 'fresh',
  };
  const galaEdited: CharacterLook = {
    ...GALA,
    lookVersionId: 'lookver-gala-2',
    clothing: 'blue gown',
  };
  const galaRedrawn: CharacterLook = {
    ...galaEdited,
    selectedSheetVersionId: 'csv-alice-gala-2',
  };

  it('a look no scene wears changes nothing', async () => {
    expect(await verdictsOf(withGala(BASE), await stampShot())).toEqual(FRESH);
  });

  it('switching the scene to another look stales its still and prompts', async () => {
    expect(await verdictsOf(inGala(withGala(BASE)), await stampShot())).toEqual(
      { still: 'stale', visualPrompt: 'stale', motionPrompt: 'stale' }
    );
  });

  it('editing a look leaves a scene that does not wear it fresh', async () => {
    const stamps = await stampShot(withGala(BASE));
    expect(await verdictsOf(withGala(BASE, galaRedrawn), stamps)).toEqual(
      FRESH
    );
  });

  it('editing a look stales the prompts of a scene that wears it, and its still once the sheet is redrawn', async () => {
    const stamps = await stampShot(inGala(withGala(BASE)));
    expect(await verdictsOf(inGala(withGala(BASE)), stamps)).toEqual(FRESH);
    // The clothing moved: the prompts read it. The still attaches the sheet,
    // which is stale on its own row until it is redrawn.
    expect(
      await verdictsOf(inGala(withGala(BASE, galaEdited)), stamps)
    ).toEqual({ still: 'fresh', visualPrompt: 'stale', motionPrompt: 'stale' });
    expect(
      await verdictsOf(inGala(withGala(BASE, galaRedrawn)), stamps)
    ).toEqual({ still: 'stale', visualPrompt: 'stale', motionPrompt: 'stale' });
  });

  it('editing the default look leaves a scene in another look fresh', async () => {
    const stamps = await stampShot(inGala(withGala(BASE)));
    const defaultEdited = inGala(
      withGala(
        withCharacter(BASE, 'c-alice', {
          standardClothing: 'grey overalls',
          selectedSheetVersionId: 'csv-alice-2',
        })
      )
    );
    expect(await verdictsOf(defaultEdited, stamps)).toEqual(FRESH);
  });
});

// ---------------------------------------------------------------------------
// The default look owns the features (#2065). What the bible called
// distinguishing features is the default look's styling now. Nothing is
// migrated: until that styling is edited the text stays on the bible
// version, the look read joins it, and every artifact stamped before the
// change verifies against the stored parts.
// ---------------------------------------------------------------------------

const FEATURES = 'scar above right eye';
/**
 * Alice as a read returns her while the features are still on her bible
 * version: `own` is her default look's stored styling, and the styling she
 * wears is that joined with the features.
 */
const aliceWithFeatures = (
  own: string | null,
  others: CharacterLook[] = []
): CharacterRow => {
  const row = {
    ...ALICE,
    legacyDistinguishingFeatures: FEATURES,
    styling: effectiveStyling(own, FEATURES),
  };
  return {
    ...row,
    looks: [{ ...defaultLookOf(row), storedStyling: own }, ...others],
  };
};
/** Alice after her default look's styling was edited: the text has moved. */
const aliceMoved = (styling: string): CharacterRow => {
  const row = { ...ALICE, legacyDistinguishingFeatures: null, styling };
  return { ...row, looks: [defaultLookOf(row)] };
};
/**
 * What the pre-#2065 hasher read for the BASE cast, by script id: Alice's
 * features and the given own styling of the look she wears; Bob has neither.
 */
const partsBefore2065 = (
  aliceOwnStyling: string | null
): LegacyStylingByCharacter => ({
  alice: { distinguishingFeatures: FEATURES, styling: aliceOwnStyling },
  bob: { distinguishingFeatures: null, styling: null },
});
const withAlice = (w: World, alice: CharacterRow): World => ({
  ...w,
  characters: w.characters.map((c) => (c.id === alice.id ? alice : c)),
});
const BRUISED_GALA = asStub<CharacterLook>({
  ...GALA,
  styling: 'split lip',
  storedStyling: 'split lip',
});

describe('staleness matrix — the default look owns the features (#2065)', () => {
  const promptsOf = async (world: World, stamps: Stamps) => {
    const v = await shotVerdicts(world, stamps);
    return {
      still: v.thumbnail,
      visualPrompt: v.visualPrompt,
      motionPrompt: v.motionPrompt,
    };
  };
  const FRESH = {
    still: 'fresh',
    visualPrompt: 'fresh',
    motionPrompt: 'fresh',
  };
  const PROMPTS_STALE = {
    still: 'fresh',
    visualPrompt: 'stale',
    motionPrompt: 'stale',
  };

  it.each([
    { name: 'styling of its own', own: 'hair pinned up' },
    { name: 'no styling of its own', own: null },
  ])(
    '4a: stamped before #2065 in the default look with $name → all fresh',
    async ({ own }) => {
      const world = withAlice(BASE, aliceWithFeatures(own));
      const stamps = await stampShotBefore2065(world, partsBefore2065(own));
      expect(await promptsOf(world, stamps)).toEqual(FRESH);
      // The stamp read these parts: one made from the other look's styling,
      // or without the features, is a different digest.
      for (const wrong of [
        partsBefore2065('split lip'),
        {
          ...partsBefore2065(own),
          alice: { distinguishingFeatures: null, styling: own },
        },
      ]) {
        expect(
          await promptsOf(world, await stampShotBefore2065(world, wrong))
        ).toEqual(PROMPTS_STALE);
      }
    }
  );

  it('4a: stamped before #2065 in another look → all fresh', async () => {
    const world = inGala(
      withAlice(BASE, aliceWithFeatures('hair pinned up', [BRUISED_GALA]))
    );
    // In the gala look the old hasher read the gala look's own styling,
    // and the features beside it.
    expect(
      await promptsOf(
        world,
        await stampShotBefore2065(world, partsBefore2065('split lip'))
      )
    ).toEqual(FRESH);
    // The default look's styling is not what a gala stamp read.
    expect(
      await promptsOf(
        world,
        await stampShotBefore2065(world, partsBefore2065('hair pinned up'))
      )
    ).toEqual(PROMPTS_STALE);
  });

  it('4b: the default look’s styling edited → prompts stale; a new stamp is fresh', async () => {
    const before = withAlice(BASE, aliceWithFeatures('hair pinned up'));
    const stamps = await stampShotBefore2065(
      before,
      partsBefore2065('hair pinned up')
    );
    // The save wrote the submitted text to the look and nulled the bible's.
    const after = withAlice(BASE, aliceMoved('hair down, no scar'));
    expect(await promptsOf(after, stamps)).toEqual(PROMPTS_STALE);
    expect(await promptsOf(after, await stampShot(after))).toEqual(FRESH);
  });

  it('4b: a stamp made after #2065, before any edit, is fresh', async () => {
    const world = withAlice(BASE, aliceWithFeatures('hair pinned up'));
    expect(await promptsOf(world, await stampShot(world))).toEqual(FRESH);
  });

  // 4c (a save that changes nothing) has no row here: the save writes no row
  // and moves no derived hash, which only a real write can show. Pinned in
  // sequence-cast-crud.test.ts, "4c: a save of what the field showed writes
  // nothing".

  it('4d: an edit to the age stales the prompts, as before, and nothing more', async () => {
    const before = withAlice(BASE, aliceWithFeatures('hair pinned up'));
    const stamps = await stampShotBefore2065(
      before,
      partsBefore2065('hair pinned up')
    );
    const aged = withAlice(BASE, {
      ...aliceWithFeatures('hair pinned up'),
      age: '31',
    });
    expect(await promptsOf(aged, stamps)).toEqual(PROMPTS_STALE);
  });

  it('a look that is not the default no longer reads the features: moving them leaves a new stamp fresh', async () => {
    const before = inGala(
      withAlice(BASE, aliceWithFeatures('hair pinned up', [BRUISED_GALA]))
    );
    const stamps = await stampShot(before);
    const moved = aliceMoved('hair down');
    const after = inGala(
      withAlice(BASE, { ...moved, looks: [...moved.looks, BRUISED_GALA] })
    );
    expect(await promptsOf(after, stamps)).toEqual(FRESH);
  });
});

// ---------------------------------------------------------------------------
// Reference sheets — `readReferenceStaleness`, stamped by the regenerate
// payload builder, the writer a Generate click uses.
// ---------------------------------------------------------------------------

const TALENT = {
  id: 't-1',
  description: 'Headshot reference',
  sheets: [
    {
      isDefault: true,
      divergedAt: null,
      imageUrl: '/r2/talent-1.png',
      metadata: null,
      inputHash: 'talent-sheet-1',
    },
  ],
};
const LIBRARY = {
  id: 'lib-1',
  description: 'a real beach',
  referenceImageUrl: '/r2/library-1.png',
  referenceInputHash: 'library-ref-1',
};

type CastWorld = {
  sequence: {
    id: string;
    status: 'completed';
    styleId: string | null;
    styleConfig: StyleConfig;
    imageModel: string | null;
  };
  alice: CharacterRow;
  beach: SequenceLocationWithReference;
  talent: typeof TALENT;
  library: typeof LIBRARY;
};

const CAST_BASE: CastWorld = {
  sequence: {
    id: 'seq',
    status: 'completed',
    styleId: null,
    styleConfig: STYLE,
    imageModel: DEFAULT_IMAGE_MODEL,
  },
  alice: { ...ALICE, talentId: 't-1' },
  beach: { ...BEACH, libraryLocationId: 'lib-1' },
  talent: TALENT,
  library: LIBRARY,
};

function castDb(world: CastWorld) {
  return asStub<ScopedDb>({
    userId: 'user-1',
    teamId: 'team-1',
    sequences: { getById: () => Promise.resolve(world.sequence) },
    characters: { getById: () => Promise.resolve(withLooks(world.alice)) },
    sequenceLocations: { getById: () => Promise.resolve(world.beach) },
    talent: { getWithRelations: () => Promise.resolve(world.talent) },
    locations: { getById: () => Promise.resolve(world.library) },
    // The live sheet pins the model it was drawn with.
    characterSheetVariants: {
      getById: () => Promise.resolve({ model: DEFAULT_IMAGE_MODEL }),
    },
    locationSheetVariants: {
      getById: () => Promise.resolve({ model: DEFAULT_IMAGE_MODEL }),
    },
  });
}

async function stampSheets(): Promise<CastWorld> {
  const context = {
    scopedDb: castDb(CAST_BASE),
    userId: 'user-1',
    teamId: 'team-1',
    sequence: CAST_BASE.sequence,
  };
  const [sheet, reference] = await Promise.all([
    buildRegenerateCharacterSheetPayload({
      ...context,
      character: withLooks(CAST_BASE.alice),
      lookId: CAST_BASE.alice.lookId,
    }),
    buildRegenerateLocationSheetPayload({
      ...context,
      location: CAST_BASE.beach,
    }),
  ]);
  return {
    ...CAST_BASE,
    alice: {
      ...CAST_BASE.alice,
      sheetInputHash: sheet.snapshotInputHash ?? null,
    },
    beach: {
      ...CAST_BASE.beach,
      referenceInputHash: reference.snapshotInputHash ?? null,
    },
  };
}

type SheetRow = {
  mutation: string;
  apply: (w: CastWorld) => CastWorld;
  character: 'stale' | 'fresh' | 'untracked';
  location: 'stale' | 'fresh';
};

const SHEET_MATRIX: SheetRow[] = [
  {
    mutation: "Alice's description edited",
    apply: (w) => ({
      ...w,
      alice: { ...w.alice, physicalDescription: 'short, red hair' },
    }),
    character: 'stale',
    location: 'fresh',
  },
  {
    mutation: "Alice's default look's clothing edited (#2015)",
    apply: (w) => ({
      ...w,
      alice: { ...w.alice, standardClothing: 'red raincoat' },
    }),
    character: 'stale',
    location: 'fresh',
  },
  {
    mutation: "Alice's default look given styling notes (#2015)",
    apply: (w) => ({ ...w, alice: { ...w.alice, styling: 'split lip' } }),
    character: 'stale',
    location: 'fresh',
  },
  {
    mutation: "Alice's default look renamed (a label, #2015)",
    apply: (w) => ({ ...w, alice: { ...w.alice, lookName: 'Office' } }),
    character: 'fresh',
    location: 'fresh',
  },
  {
    mutation: "Alice's personality edited (motion only)",
    apply: (w) => ({ ...w, alice: { ...w.alice, personality: 'restless' } }),
    character: 'fresh',
    location: 'fresh',
  },
  {
    mutation: 'Alice renamed (a label)',
    apply: (w) => ({ ...w, alice: { ...w.alice, name: 'Alicia' } }),
    character: 'fresh',
    location: 'fresh',
  },
  {
    mutation: "Alice's consistency tag edited (the sheet prompt reads it)",
    apply: (w) => ({ ...w, alice: { ...w.alice, consistencyTag: 'alice_v2' } }),
    character: 'stale',
    location: 'fresh',
  },
  {
    mutation: "the beach's consistency tag edited (a label)",
    apply: (w) => ({ ...w, beach: { ...w.beach, consistencyTag: 'beach_v2' } }),
    character: 'fresh',
    location: 'fresh',
  },
  {
    mutation: 'Alice made voice-only (no sheet to be stale)',
    apply: (w) => ({ ...w, alice: { ...w.alice, voiceOnly: true } }),
    character: 'untracked',
    location: 'fresh',
  },
  {
    mutation: "cast talent's sheet regenerated",
    apply: (w) => ({
      ...w,
      talent: {
        ...w.talent,
        sheets: [
          {
            isDefault: true,
            divergedAt: null,
            imageUrl: '/r2/talent-2.png',
            metadata: null,
            inputHash: 'talent-sheet-2',
          },
        ],
      },
    }),
    character: 'stale',
    location: 'fresh',
  },
  {
    mutation: "cast talent's description edited",
    apply: (w) => ({
      ...w,
      talent: { ...w.talent, description: 'Full body reference' },
    }),
    character: 'stale',
    location: 'fresh',
  },
  {
    mutation: 'style lighting changed',
    apply: (w) => ({
      ...w,
      sequence: {
        ...w.sequence,
        styleConfig: {
          ...STYLE,
          look: { ...STYLE.look, lighting: 'hard noon sun' },
        },
      },
    }),
    // A character sheet reads no style since `rendering` (#2017).
    character: 'fresh',
    location: 'stale',
  },
  {
    mutation: 'sequence image model switched (sheets pin their own, #1785)',
    apply: (w) => ({
      ...w,
      sequence: { ...w.sequence, imageModel: 'flux_2_pro' },
    }),
    character: 'fresh',
    location: 'fresh',
  },
  {
    mutation: 'location description edited',
    apply: (w) => ({
      ...w,
      beach: { ...w.beach, description: 'black volcanic sand' },
    }),
    character: 'fresh',
    location: 'stale',
  },
  {
    mutation: 'location fixtures edited',
    apply: (w) => ({ ...w, beach: { ...w.beach, keyFeatures: 'neon sign' } }),
    character: 'fresh',
    location: 'stale',
  },
  {
    mutation: 'location ambiance edited',
    apply: (w) => ({ ...w, beach: { ...w.beach, ambiance: 'eerie calm' } }),
    character: 'fresh',
    location: 'stale',
  },
  {
    mutation: 'location renamed (a label)',
    apply: (w) => ({ ...w, beach: { ...w.beach, name: 'The Shore' } }),
    character: 'fresh',
    location: 'fresh',
  },
  {
    mutation: 'library location reference regenerated',
    apply: (w) => ({
      ...w,
      library: {
        ...w.library,
        referenceImageUrl: '/r2/library-2.png',
        referenceInputHash: 'library-ref-2',
      },
    }),
    character: 'fresh',
    location: 'stale',
  },
];

describe('staleness matrix — reference sheets', () => {
  const verdict = async (world: CastWorld, kind: 'character' | 'location') =>
    (
      await readReferenceStaleness(
        castDb(world),
        'seq',
        kind,
        kind === 'character' ? 'c-alice' : 'l-beach'
      )
    ).status;

  it('reads both sheets fresh against the regenerate stamp', async () => {
    const stamped = await stampSheets();
    expect(await verdict(stamped, 'character')).toBe('fresh');
    expect(await verdict(stamped, 'location')).toBe('fresh');
  });

  describe('the default look owns the features (#2065)', () => {
    const cast = (row: CharacterRow): CharacterRow => ({
      ...row,
      talentId: 't-1',
    });
    const db = (row: CharacterRow) =>
      asStub<ScopedDb>({
        ...castDb(CAST_BASE),
        characters: { getById: () => Promise.resolve(row) },
      });
    /** `row` with `lookId`'s sheet stamped as given. */
    const stamped = (
      row: CharacterRow,
      lookId: string,
      sheetInputHash: string | null
    ): CharacterRow => ({
      ...row,
      ...(row.lookId === lookId ? { sheetInputHash } : {}),
      looks: row.looks.map((look) =>
        look.id === lookId ? { ...look, sheetInputHash } : look
      ),
    });
    const payloadOf = (row: CharacterRow, lookId: string) =>
      buildRegenerateCharacterSheetPayload({
        scopedDb: db(row),
        userId: 'user-1',
        teamId: 'team-1',
        sequence: CAST_BASE.sequence,
        character: row,
        lookId,
      });
    /** The digest the hasher stamped before #2065, from the stored parts. */
    const stampBefore2065 = async (
      row: CharacterRow,
      lookId: string,
      own: string | null
    ) =>
      stamped(
        row,
        lookId,
        await computeCharacterSheetHashFromDtoBefore2065(
          await payloadOf(row, lookId),
          { distinguishingFeatures: FEATURES, styling: own },
          await computeStyleConfigHash(STYLE)
        )
      );
    const verdictOf = async (row: CharacterRow, lookId: string) =>
      (await readLookSheetStaleness(db(row), 'seq', 'c-alice', lookId)).status;

    it.each([
      { name: 'styling of its own', own: 'hair pinned up' },
      { name: 'no styling of its own', own: null },
    ])(
      '4a: the default look’s sheet, with $name, stamped before #2065 → fresh',
      async ({ own }) => {
        const row = await stampBefore2065(
          cast(aliceWithFeatures(own)),
          'c-alice',
          own
        );
        expect(await verdictOf(row, 'c-alice')).toBe('fresh');
        // Sheet reuse: the plan's second lookup computes this stamp from the
        // row's stored parts, so another sequence adopts the old sheet.
        const payload = await payloadOf(row, 'c-alice');
        expect(payload.snapshotInputHash).not.toBe(row.sheetInputHash);
        expect(
          await computeCharacterSheetHashFromDtoBefore2065(
            payload,
            legacyStylingParts(row),
            await computeStyleConfigHash(STYLE)
          )
        ).toBe(row.sheetInputHash);
        // 4d: an edit to the age stales it, as before.
        expect(await verdictOf({ ...row, age: '31' }, 'c-alice')).toBe('stale');
      }
    );

    it('4a: another look’s sheet stamped before #2065 → fresh', async () => {
      const row = await stampBefore2065(
        cast(aliceWithFeatures('hair pinned up', [BRUISED_GALA])),
        GALA.id,
        'split lip'
      );
      expect(await verdictOf(row, GALA.id)).toBe('fresh');
    });

    it('4b: the default look’s styling edited → its old sheet is stale, a new one fresh', async () => {
      const before = await stampBefore2065(
        cast(aliceWithFeatures('hair pinned up')),
        'c-alice',
        'hair pinned up'
      );
      const oldStamp = before.sheetInputHash;
      const after = cast(aliceMoved('hair down, no scar'));
      expect(
        await verdictOf(stamped(after, 'c-alice', oldStamp), 'c-alice')
      ).toBe('stale');
      const { snapshotInputHash } = await payloadOf(after, 'c-alice');
      expect(
        await verdictOf(stamped(after, 'c-alice', snapshotInputHash), 'c-alice')
      ).toBe('fresh');
    });
  });

  it("verifies each look's sheet against its own clothing (#2015)", async () => {
    const stamped = await stampSheets();
    // Alice with a second look, its sheet stamped from that look.
    const aliceWith = (gala: CharacterLook) => withLooks(stamped.alice, [gala]);
    const db = (gala: CharacterLook) =>
      asStub<ScopedDb>({
        ...castDb(stamped),
        characters: { getById: () => Promise.resolve(aliceWith(gala)) },
      });
    const { snapshotInputHash } = await buildRegenerateCharacterSheetPayload({
      scopedDb: db(GALA),
      userId: 'user-1',
      teamId: 'team-1',
      sequence: stamped.sequence,
      character: aliceWith(GALA),
      lookId: GALA.id,
    });
    const gala = { ...GALA, sheetInputHash: snapshotInputHash };
    const galaVerdict = async (look: CharacterLook) =>
      (await readLookSheetStaleness(db(look), 'seq', 'c-alice', GALA.id))
        .status;

    expect(await galaVerdict(gala)).toBe('fresh');
    expect(await galaVerdict({ ...gala, clothing: 'blue gown' })).toBe('stale');
    // The gown is drawn from the default look's sheet. A new face stales it.
    const movedFace = asStub<ScopedDb>({
      ...castDb(stamped),
      characters: {
        getById: () =>
          Promise.resolve(
            withLooks(
              { ...stamped.alice, selectedSheetVersionId: 'csv-alice-2' },
              [gala]
            )
          ),
      },
    });
    expect(
      (await readLookSheetStaleness(movedFace, 'seq', 'c-alice', GALA.id))
        .status
    ).toBe('stale');
    // The gown's edit leaves the default look's sheet alone.
    expect(
      (
        await readReferenceStaleness(
          db({ ...gala, clothing: 'blue gown' }),
          'seq',
          'character',
          'c-alice'
        )
      ).status
    ).toBe('fresh');
    // An id that is no look of hers is an error, not the default's verdict.
    await expect(
      readLookSheetStaleness(db(gala), 'seq', 'c-alice', 'no-such-look')
    ).rejects.toThrow('not found');
    // The two looks are different sheets: different digests.
    expect(snapshotInputHash).not.toBe(stamped.alice.sheetInputHash);
  });

  it.each(SHEET_MATRIX)(
    '$mutation → character sheet $character, location sheet $location',
    async (row) => {
      const world = row.apply(await stampSheets());
      expect({
        character: await verdict(world, 'character'),
        location: await verdict(world, 'location'),
      }).toEqual({ character: row.character, location: row.location });
    }
  );

  // The location sheet prompt reads the library location's description and
  // image from the library row, but the hash only sees the library
  // reference's own hash, which moves when that reference is regenerated and
  // not when the description is edited. `recastLocationFn` takes those values
  // from the client, so hashing them needs care (#1823).
  it.todo(
    'library location description edited, reference not regenerated → location sheet stale'
  );
});

// ---------------------------------------------------------------------------
// Music — `readMusicPromptStaleness`, prompt and track.
// ---------------------------------------------------------------------------

const AUDIO_MODEL = 'ace_step';

type MusicWorld = {
  scenes: {
    id: string;
    title: string;
    storyBeat: string;
    location: string;
    timeOfDay: string;
  }[];
  shots: { sceneId: string; durationMs: number }[];
  musicPrompt: string;
  musicTags: string;
  /** False once the prompt is regenerated or hand-edited (#1657). */
  promptStamped: boolean;
};

const MUSIC_BASE: MusicWorld = {
  scenes: [
    {
      id: 'scene-1',
      title: 'Pickup',
      storyBeat: 'inciting',
      location: 'rooftop',
      timeOfDay: 'night',
    },
    {
      id: 'scene-2',
      title: 'Chase',
      storyBeat: 'twist',
      location: 'alley',
      timeOfDay: 'night',
    },
  ],
  shots: [
    { sceneId: 'scene-1', durationMs: 4000 },
    { sceneId: 'scene-1', durationMs: 6000 },
    { sceneId: 'scene-2', durationMs: 5000 },
  ],
  musicPrompt: 'tense synth pulse',
  musicTags: 'synth, tense',
  promptStamped: true,
};

async function musicVerdicts(world: MusicWorld) {
  const promptStamp = await computeMusicPromptInputHash({
    sceneSummaries: musicSceneSummariesFromRows(
      MUSIC_BASE.scenes,
      MUSIC_BASE.shots
    ).sceneSummaries,
    analysisModel: ANALYSIS_MODEL,
  });
  const trackStamp = await computeSequenceMusicInputHash({
    prompt: MUSIC_BASE.musicPrompt,
    tags: MUSIC_BASE.musicTags,
    durationSeconds: 15,
    audioModel: AUDIO_MODEL,
  });
  const scopedDb = asStub<ScopedDb>({
    shots: { listBySequence: () => Promise.resolve(world.shots) },
    scenes: { listBySequence: () => Promise.resolve(world.scenes) },
    sequenceVariants: {
      getMusicById: () =>
        Promise.resolve({
          status: 'completed',
          model: AUDIO_MODEL,
          inputHash: trackStamp,
        }),
    },
    sequenceMusicPromptVersions: {
      getSelected: () => Promise.resolve({ analysisModel: ANALYSIS_MODEL }),
    },
  });
  return readMusicPromptStaleness(
    scopedDb,
    asStub({
      id: 'seq',
      status: 'completed',
      analysisModel: ANALYSIS_MODEL,
      selectedMusicVariantId: 'track',
      musicPrompt: world.musicPrompt,
      musicTags: world.musicTags,
      musicPromptInputHash: world.promptStamped ? promptStamp : null,
    })
  );
}

type MusicRow = {
  mutation: string;
  apply: (w: MusicWorld) => MusicWorld;
  musicPrompt: 'stale' | 'fresh' | 'untracked';
  musicTrack: 'stale' | 'fresh';
};

const withFirstScene = (
  w: MusicWorld,
  fields: Partial<MusicWorld['scenes'][number]>
): MusicWorld => ({
  ...w,
  scenes: w.scenes.map((s, i) => (i === 0 ? { ...s, ...fields } : s)),
});

const MUSIC_MATRIX: MusicRow[] = [
  {
    mutation: 'scene story beat edited',
    apply: (w) => withFirstScene(w, { storyBeat: 'climax' }),
    musicPrompt: 'stale',
    musicTrack: 'fresh',
  },
  {
    mutation: 'scene heading edited',
    apply: (w) => withFirstScene(w, { location: 'bridge' }),
    musicPrompt: 'stale',
    musicTrack: 'fresh',
  },
  {
    mutation: 'scene time of day edited',
    apply: (w) => withFirstScene(w, { timeOfDay: 'dawn' }),
    musicPrompt: 'stale',
    musicTrack: 'fresh',
  },
  {
    mutation: 'scene title renamed (a label)',
    apply: (w) => withFirstScene(w, { title: 'The pickup' }),
    musicPrompt: 'fresh',
    musicTrack: 'fresh',
  },
  {
    mutation: 'shot duration changed',
    apply: (w) => ({
      ...w,
      shots: [{ sceneId: 'scene-1', durationMs: 8000 }, ...w.shots.slice(1)],
    }),
    // The brief carries each scene's length; the track was billed for the
    // old total.
    musicPrompt: 'stale',
    musicTrack: 'stale',
  },
  {
    mutation: 'scene deleted with its shots',
    apply: (w) => ({
      ...w,
      scenes: w.scenes.slice(0, 1),
      shots: w.shots.filter((s) => s.sceneId === 'scene-1'),
    }),
    musicPrompt: 'stale',
    musicTrack: 'stale',
  },
  {
    mutation: 'music prompt regenerated or edited',
    apply: (w) => ({
      ...w,
      musicPrompt: 'warm strings',
      promptStamped: false,
    }),
    musicPrompt: 'untracked',
    musicTrack: 'stale',
  },
  {
    mutation: 'music tags edited',
    apply: (w) => ({ ...w, musicTags: 'strings, warm' }),
    musicPrompt: 'fresh',
    musicTrack: 'stale',
  },
];

describe('staleness matrix — music', () => {
  it('reads the prompt and track fresh against their stamps', async () => {
    expect(await musicVerdicts(MUSIC_BASE)).toEqual({
      musicPrompt: 'fresh',
      musicTrack: 'fresh',
    });
  });

  it.each(MUSIC_MATRIX)(
    '$mutation → prompt $musicPrompt, track $musicTrack',
    async (row) => {
      expect(await musicVerdicts(row.apply(MUSIC_BASE))).toEqual({
        musicPrompt: row.musicPrompt,
        musicTrack: row.musicTrack,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Stamp == verify. Each writer's stamp must be what verify recomputes from
// the rows it wrote, or its artifact is born stale:
//   - shot stills (upload): media-upload.test.ts
//   - visual and motion prompts (pipeline): analyze-script-checkpoint.test.ts,
//     prompt-context.test.ts, input-hash.test.ts (#1784)
//   - music prompt (pipeline): music-scene-summaries.test.ts,
//     music-staleness.test.ts
//   - character sheets (pipeline): character-bible-workflow.test.ts
//   - character and location sheets (regenerate): the sheet matrix above
//   - location sheets (pipeline): below
// ---------------------------------------------------------------------------

describe('stamp == verify', () => {
  it('a pipeline location sheet reads fresh from the row the pipeline wrote (#1113)', async () => {
    const entry = {
      locationId: 'beach',
      name: 'Beach',
      type: 'exterior' as const,
      description: 'white sand',
      architecturalStyle: '',
      keyFeatures: 'driftwood',
      ambiance: '',
      consistencyTag: 'beach_tag',
      firstMention: { sceneId: 'scene-1', text: 'BEACH', lineNumber: 1 },
    };
    const libraryMatch = {
      locationId: 'beach',
      libraryLocationId: 'lib-1',
      referenceImageUrl: LIBRARY.referenceImageUrl,
      description: LIBRARY.description,
      referenceInputHash: LIBRARY.referenceInputHash,
    };
    // `LocationBibleWorkflow`'s child payload, as it stamps it.
    const stamp = await computeLocationSheetHashFromDto({
      userId: 'user-1',
      teamId: 'team-1',
      sequenceId: 'seq',
      locationDbId: 'l-beach',
      bibleVersionId: null,
      locationName: entry.name,
      locationMetadata: entry,
      imageModel: DEFAULT_IMAGE_MODEL,
      referenceImageUrl: libraryMatch.referenceImageUrl,
      libraryLocationDescription: libraryMatch.description,
      styleConfig: STYLE,
      libraryLocationReferenceHash: libraryMatch.referenceInputHash,
    });

    // What D1 holds after `create-location-records`, read back.
    const row = asStub<SequenceLocationWithReference>({
      ...buildLocationInsert({
        sequenceId: 'seq',
        location: entry,
        libraryMatch: asStub(libraryMatch),
        referenceStatus: 'completed',
      }),
      id: 'l-beach',
      selectedReferenceVersionId: 'lsv-1',
      selectedBibleVersionId: null,
      referenceInputHash: stamp,
      referenceImageUrl: null,
      deletedAt: null,
    });
    expect(toLocationMetadata(row)).toEqual(entry);
    const status = await readReferenceStaleness(
      castDb({ ...CAST_BASE, beach: row }),
      'seq',
      'location',
      row.id
    );
    expect(status.status).toBe('fresh');
  });
});
