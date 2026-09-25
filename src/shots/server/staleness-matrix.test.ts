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
import { readReferenceStaleness } from '@/cast/server/production-staleness';
import { buildRegenerateCharacterSheetPayload } from '@/cast/server/sheets/character-sheet-trigger';
import {
  buildRegenerateLocationSheetPayload,
  toLocationMetadata,
} from '@/cast/server/sheets/location-sheet-trigger';
import { buildLocationInsert } from '@/cast/server/workflows/cast-records';
import { computeLocationSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import { readMusicPromptStaleness } from '@/audio/server/music-staleness';
import { musicSceneSummariesFromRows } from '@/audio/server/workflows/music-scene-summaries';
import {
  computeMusicPromptInputHash,
  computeSequenceMusicInputHash,
} from '@/shots/input-hash';
import { computeShotStaleness } from './shot-staleness';

function asStub<T>(stub: unknown): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as T;
}

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
const character = (fields: Partial<CharacterRow>): CharacterRow =>
  asStub<CharacterRow>({
    sequenceId: 'seq',
    age: '30',
    gender: null,
    ethnicity: null,
    standardClothing: null,
    distinguishingFeatures: null,
    personality: null,
    movement: null,
    voiceDescription: null,
    voiceOnly: false,
    isPerson: true,
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
  timeOfDay: 'day',
  description: 'white sand',
  architecturalStyle: null,
  keyFeatures: null,
  colorPalette: null,
  lightingSetup: null,
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
function shotDb(world: World, stamps: Stamps) {
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
        Promise.resolve({ inputHash: stamps.motionPrompt, createdAt: AT }),
      getLatest: () => Promise.resolve({ analysisModel: ANALYSIS_MODEL }),
      getLatestWithInputHash: none,
      getLivePending: none,
    },
    frameVariants: { listLiveClaims: empty },
    // Only the stale-cause hints read these.
    characters: { listBibleVersionsBySequence: empty },
    sequenceLocations: { listBibleVersionsBySequence: empty },
    sceneScriptVersions: { listBySequence: empty, getSelected: none },
    scenes: { getById: none },
    sequences: { listStyleVersions: empty },
    shotDialogue: { getSelectedBySequence: empty },
    sequenceEvents: { listByTarget: empty },
  });
}

async function shotVerdicts(world: World, stamps: Stamps) {
  return computeShotStaleness({
    scopedDb: shotDb(world, stamps),
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

/** Stamp every shot artifact from `BASE`, as its generation would have. */
async function stampShot(): Promise<Stamps> {
  const { liveHashes } = await shotVerdicts(BASE, {
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
    },
  });
  if (!segment) throw new Error('test setup: no segment');
  return segment.stale;
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
    // The motion prompt is written looking at the still.
    stale: ['motionPrompt', 'clip'],
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
    // The still attaches the sheets its prompt names (#1432): still Alice's.
    stale: ['visualPrompt', 'motionPrompt'],
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
    mutation: 'location lighting edited',
    apply: (w) => withLocation(w, { lightingSetup: 'low sun' }),
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
    // token. A label-only rename reading fresh needs a token-normalised
    // hash; that is an open owner decision (#1827).
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
      };
    },
    stale: ['still', 'visualPrompt', 'motionPrompt'],
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

  // Both prompts read fresh today. The visual hash drops a voice-only
  // character (#1785), but the pre-#1785 digest kept her, so it equals the
  // stamp and verify accepts it until the `LEGACY_HASH_UNTIL` fallbacks are
  // deleted (#1371). The motion LLM is sent the `voiceOnly` flag in the
  // character JSON, but the motion hash does not read it.
  it.todo('Alice made voice-only → visual and motion prompts stale');

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
    characters: { getById: () => Promise.resolve(world.alice) },
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
      character: CAST_BASE.alice,
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
    character: 'stale',
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
    mutation: 'location time of day edited',
    apply: (w) => ({ ...w, beach: { ...w.beach, timeOfDay: 'night' } }),
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
      getMusicPrimary: () =>
        Promise.resolve({
          status: 'completed',
          model: AUDIO_MODEL,
          inputHash: trackStamp,
        }),
    },
    sequenceMusicPromptVersions: {
      getLatest: () => Promise.resolve({ analysisModel: ANALYSIS_MODEL }),
    },
  });
  return readMusicPromptStaleness(
    scopedDb,
    asStub({
      id: 'seq',
      status: 'completed',
      analysisModel: ANALYSIS_MODEL,
      musicModel: AUDIO_MODEL,
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
      timeOfDay: 'day',
      description: 'white sand',
      architecturalStyle: '',
      keyFeatures: 'driftwood',
      colorPalette: '',
      lightingSetup: 'low sun',
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
