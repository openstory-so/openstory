/**
 * Staleness matrix (#1108 Phase 0 skeleton, landing with Phase 3) — a
 * table-driven contract for the DAG invalidation rules in
 * docs/plans/manual-pipeline-crud.md §4.2/§4.3: each row is one user mutation
 * and the expected freshness transition of each downstream artifact hash.
 *
 * Pure-hash level: an artifact's stamped hash is recomputed after the mutation
 * with the exact stamp-side builders (`computeShotImageSceneHash` for stills,
 * `computeVideoManifestInputHash` for renders); `same` = fresh, `different` =
 * stale. Upstream artifacts must be untouched by construction — a mutation
 * only reaches downstream hashes that embed the changed input.
 *
 * Extend this table as later phases add mutations (structure CRUD, cast/
 * location bible edits, …).
 */

import {
  computeCharacterSheetInputHash,
  computeVideoManifestInputHash,
  computeVisualPromptInputHash,
  type CharacterBibleHashFields,
  type PromptSceneContextHashInput,
} from '@/lib/ai/input-hash';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/lib/ai/scene-analysis.schema';
import { narrowShotPromptContext } from '@/lib/ai/prompt-context';
import type { StyleConfig, VideoManifest } from '@/lib/db/schema';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';
import { describe, expect, it } from 'vitest';

/** The inputs each artifact hash is computed over, before/after a mutation. */
type PipelineState = {
  /** Selected visual prompt text (image hash input). */
  visualPromptText: string;
  /** Character/location/element reference-hash sets (image hash inputs). */
  characterSheetHashes: string[];
  locationSheetHashes: string[];
  elementReferenceHashes: string[];
  imageModel: string;
  aspectRatio: string;
  /** Selected version pointers + duration (video manifest inputs). */
  selectedFrameVersionId: string | null;
  selectedMotionPromptVersionId: string | null;
  durationMs: number;
  videoModel: string;
};

const BASE: PipelineState = {
  visualPromptText: 'a red car at dawn',
  characterSheetHashes: ['char-sheet-1'],
  locationSheetHashes: ['loc-sheet-1'],
  elementReferenceHashes: [],
  imageModel: 'nano_banana_2',
  aspectRatio: '16:9',
  selectedFrameVersionId: 'frame-v1',
  selectedMotionPromptVersionId: 'motion-v1',
  durationMs: 4000,
  videoModel: 'kling_25',
};

function imageHash(state: PipelineState): Promise<string> {
  return computeShotImageSceneHash(
    {
      sceneId: 'scene-1',
      visualPrompt: state.visualPromptText,
      characterSheetHashes: state.characterSheetHashes,
      locationSheetHashes: state.locationSheetHashes,
      elementReferenceHashes: state.elementReferenceHashes,
    },
    state.imageModel,
    state.aspectRatio
  );
}

function videoHash(state: PipelineState): Promise<string> {
  const manifest: VideoManifest = [
    {
      shotId: 'shot-1',
      motionPromptVersionId: state.selectedMotionPromptVersionId,
      frameVersionId: state.selectedFrameVersionId,
      durationMs: state.durationMs,
    },
  ];
  return computeVideoManifestInputHash(manifest, state.videoModel);
}

type Expectation = 'fresh' | 'stale';

type MatrixRow = {
  mutation: string;
  /** State transition the mutation causes (selection pointers included). */
  apply: (s: PipelineState) => PipelineState;
  /**
   * Expected staleness of an artifact STAMPED BEFORE the mutation, verified
   * against the post-mutation state.
   */
  expected: { image: Expectation; video: Expectation };
};

const MATRIX: MatrixRow[] = [
  {
    // §4.3 A — prompt-only user edit: image goes stale (prompt text is in the
    // image hash); video stays fresh until the image itself moves (the render
    // manifest references version ids, not prompt text).
    mutation: 'visual prompt edited (prompt-only, §4.3 A)',
    apply: (s) => ({ ...s, visualPromptText: 'a blue motorcycle at dusk' }),
    expected: { image: 'stale', video: 'fresh' },
  },
  {
    // §4.3 B — still replaced (upload or regen + select): the video manifest
    // now names a superseded frame version → stale. The image expectation
    // here covers the OLD still — the freshly uploaded one is stamped from
    // current inputs and is fresh by construction (see media-upload.test.ts).
    mutation: 'still replaced — new frame version selected (§4.3 B)',
    apply: (s) => ({ ...s, selectedFrameVersionId: 'frame-v2-upload' }),
    expected: { image: 'fresh', video: 'stale' },
  },
  {
    // §4.3 C — prompt + image replaced atomically: both new artifacts are
    // stamped against the post-write state (asserted end-to-end in
    // media-upload.test.ts); the pre-existing video is stale via the manifest.
    mutation: 'prompt + still replaced together (§4.3 C, downstream video)',
    apply: (s) => ({
      ...s,
      visualPromptText: 'a blue motorcycle at dusk',
      selectedFrameVersionId: 'frame-v2-upload',
    }),
    expected: { image: 'stale', video: 'stale' },
  },
  {
    // Motion prompt only → video stale (manifest names the superseded motion
    // version); the still is not downstream of the motion prompt.
    mutation: 'motion prompt edited — new motion version selected',
    apply: (s) => ({ ...s, selectedMotionPromptVersionId: 'motion-v2' }),
    expected: { image: 'fresh', video: 'stale' },
  },
  {
    // Duration is a video generation parameter, not a prompt/image driver.
    mutation: 'shot duration changed',
    apply: (s) => ({ ...s, durationMs: 8000 }),
    expected: { image: 'fresh', video: 'stale' },
  },
  {
    // Character sheet regenerated/uploaded → its hash feeds the image hash;
    // the video only follows once the image is re-rendered and re-selected.
    mutation: 'character sheet hash changed',
    apply: (s) => ({ ...s, characterSheetHashes: ['char-sheet-2'] }),
    expected: { image: 'stale', video: 'fresh' },
  },
  {
    // A new selected sheet version (regen/upload) is a new identity even when
    // the parent input hash is unchanged.
    mutation: 'character sheet version id changed',
    apply: (s) => ({ ...s, characterSheetHashes: ['version-ulid-2'] }),
    expected: { image: 'stale', video: 'fresh' },
  },
  {
    // Image model switch re-stales stills of that modality only.
    mutation: 'image model changed',
    apply: (s) => ({ ...s, imageModel: 'other_image_model' }),
    expected: { image: 'stale', video: 'fresh' },
  },
  {
    // Video model switch re-stales renders of that modality only.
    mutation: 'video model changed',
    apply: (s) => ({ ...s, videoModel: 'other_video_model' }),
    expected: { image: 'fresh', video: 'stale' },
  },
];

describe('staleness matrix (§4.2 edge table)', () => {
  it.each(MATRIX)(
    '$mutation → image $expected.image, video $expected.video',
    async ({ apply, expected }) => {
      const stampedImage = await imageHash(BASE);
      const stampedVideo = await videoHash(BASE);

      const after = apply(BASE);
      const liveImage = await imageHash(after);
      const liveVideo = await videoHash(after);

      expect(liveImage === stampedImage ? 'fresh' : 'stale').toBe(
        expected.image
      );
      expect(liveVideo === stampedVideo ? 'fresh' : 'stale').toBe(
        expected.video
      );
    }
  );

  it('reference-hash sets are order-insensitive (no false staleness from readback order)', async () => {
    const a = await imageHash({
      ...BASE,
      characterSheetHashes: ['c1', 'c2'],
      locationSheetHashes: ['l1', 'l2'],
    });
    const b = await imageHash({
      ...BASE,
      characterSheetHashes: ['c2', 'c1'],
      locationSheetHashes: ['l2', 'l1'],
    });
    expect(b).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Cast / location bible mutations (#1108 Phase 2) — §4.2 rows for the visual
// prompt hash (narrowed, projected bibles) and the character-sheet hash.
// The mutation is expressed as a bible-state transition, exactly what a
// `updateBible` / `softDelete` produces in the rows the verifies read.
// ---------------------------------------------------------------------------

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

const ALICE: CharacterBibleEntry = {
  characterId: 'alice',
  name: 'Alice',
  age: '30',
  gender: '',
  ethnicity: '',
  physicalDescription: 'tall, brown hair',
  standardClothing: '',
  distinguishingFeatures: '',
  consistencyTag: 'alice_tag',
};
const BOB: CharacterBibleEntry = {
  ...ALICE,
  characterId: 'bob',
  name: 'Bob',
  consistencyTag: 'bob_tag',
};

const BEACH: LocationBibleEntry = {
  locationId: 'beach',
  name: 'Beach',
  type: 'exterior',
  timeOfDay: 'day',
  description: 'white sand',
  architecturalStyle: '',
  keyFeatures: '',
  colorPalette: '',
  lightingSetup: '',
  ambiance: '',
  consistencyTag: 'beach_tag',
  firstMention: { sceneId: 's1', text: 'BEACH', lineNumber: 1 },
};

const SCENE: Scene = {
  sceneId: 's1',
  sceneNumber: 1,
  originalScript: { extract: 'Alice walks the beach.', dialogue: [] },
  metadata: {
    title: 'Beach walk',
    durationSeconds: 5,
    location: 'Beach',
    timeOfDay: 'day',
    storyBeat: '',
  },
  continuity: {
    characterTags: ['alice'],
    environmentTag: 'beach',
    elementTags: [],
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
};

/**
 * The prompt-hash input as the staleness verify assembles it: the scene plus
 * the NARROWED bibles (only entries the scene's continuity references). A
 * soft-deleted row simply disappears from the list the narrow step consumes.
 */
type BibleState = {
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
};

function promptHash(state: BibleState): Promise<string> {
  const input: PromptSceneContextHashInput = {
    scene: SCENE,
    styleConfig: STYLE,
    characterBible: state.characterBible,
    locationBible: state.locationBible,
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
  };
  return computeVisualPromptInputHash(input);
}

function sheetHash(bible: CharacterBibleHashFields): Promise<string> {
  return computeCharacterSheetInputHash({
    characterBible: bible,
    talentSheetHash: null,
    styleConfigHash: 'style-hash-1',
    imageModel: 'nano_banana_2',
  });
}

// Narrowed base: the scene references alice + beach; bob exists in the
// sequence but is NOT in the narrowed set the hash consumes.
const BIBLE_BASE: BibleState = {
  characterBible: [ALICE],
  locationBible: [BEACH],
};

type BibleMatrixRow = {
  mutation: string;
  apply: (s: BibleState) => BibleState;
  expected: 'fresh' | 'stale';
};

const BIBLE_MATRIX: BibleMatrixRow[] = [
  {
    // updateBible on a projected driving field → prompts stale.
    mutation: "referenced character's physicalDescription edited",
    apply: (s) => ({
      ...s,
      characterBible: [{ ...ALICE, physicalDescription: 'short, red hair' }],
    }),
    expected: 'stale',
  },
  {
    // consistencyTag is dropped by the prompt projection (#867) — editing it
    // must NOT flag prompts.
    mutation: "referenced character's consistencyTag edited (projected out)",
    apply: (s) => ({
      ...s,
      characterBible: [{ ...ALICE, consistencyTag: 'alice_recast_tag' }],
    }),
    expected: 'fresh',
  },
  {
    mutation: "referenced character's name edited (display label, not hashed)",
    apply: (s) => ({
      ...s,
      characterBible: [{ ...ALICE, name: 'Alicia' }],
    }),
    expected: 'fresh',
  },
  {
    // softDelete removes the row from the bible reads → narrowed set shrinks.
    mutation: 'referenced character soft-deleted',
    apply: (s) => ({ ...s, characterBible: [] }),
    expected: 'stale',
  },
  {
    // An unreferenced character never enters the narrowed set, so neither its
    // edits nor its delete/restore can flag this scene's prompts.
    mutation: 'unreferenced character edited (bob, not in scene continuity)',
    apply: (s) => s,
    expected: 'fresh',
  },
  {
    mutation: "referenced location's name edited (display label, not hashed)",
    apply: (s) => ({
      ...s,
      locationBible: [{ ...BEACH, name: 'The Shore' }],
    }),
    expected: 'fresh',
  },
  {
    mutation: "referenced location's description edited",
    apply: (s) => ({
      ...s,
      locationBible: [{ ...BEACH, description: 'black volcanic sand' }],
    }),
    expected: 'stale',
  },
  {
    mutation: 'referenced location soft-deleted',
    apply: (s) => ({ ...s, locationBible: [] }),
    expected: 'stale',
  },
];

describe('staleness matrix — cast/location bible mutations (§4.2, Phase 2)', () => {
  it.each(BIBLE_MATRIX)(
    '$mutation → visual prompt $expected',
    async ({ apply, expected }) => {
      const stamped = await promptHash(BIBLE_BASE);
      const live = await promptHash(apply(BIBLE_BASE));
      expect(live === stamped ? 'fresh' : 'stale').toBe(expected);
    }
  );

  it('unreferenced-character row is genuinely inert through the REAL narrow step', async () => {
    // Run the actual production narrowing over full bibles: bob is not in the
    // scene's continuity, so his presence, his edit, and his soft-delete all
    // hash identically for this scene's prompt.
    const hashNarrowed = (bible: CharacterBibleEntry[]) =>
      computeVisualPromptInputHash(
        narrowShotPromptContext({
          scene: SCENE,
          styleConfig: STYLE,
          characterBible: bible,
          locationBible: [BEACH],
          elementBible: [],
          aspectRatio: '16:9',
          analysisModel: 'anthropic/claude-haiku-4.5',
        })
      );
    const withBob = await hashNarrowed([ALICE, BOB]);
    const withEditedBob = await hashNarrowed([
      ALICE,
      { ...BOB, physicalDescription: 'completely rewritten' },
    ]);
    const withBobDeleted = await hashNarrowed([ALICE]);
    expect(withEditedBob).toBe(withBob);
    expect(withBobDeleted).toBe(withBob);
  });

  it('a rename does not re-stale the character sheet (name is not hashed)', async () => {
    const stamped = await sheetHash({
      name: ALICE.name,
      age: ALICE.age,
      gender: ALICE.gender,
      ethnicity: ALICE.ethnicity,
      physicalDescription: ALICE.physicalDescription,
      standardClothing: ALICE.standardClothing,
      distinguishingFeatures: ALICE.distinguishingFeatures,
      consistencyTag: ALICE.consistencyTag,
    });
    const renamed = await sheetHash({
      name: 'Alicia',
      age: ALICE.age,
      gender: ALICE.gender,
      ethnicity: ALICE.ethnicity,
      physicalDescription: ALICE.physicalDescription,
      standardClothing: ALICE.standardClothing,
      distinguishingFeatures: ALICE.distinguishingFeatures,
      consistencyTag: ALICE.consistencyTag,
    });
    expect(renamed).toBe(stamped);
  });

  it('bible edit re-stales the character sheet (sheet hash embeds the bible fields)', async () => {
    const stamped = await sheetHash({
      name: ALICE.name,
      age: ALICE.age,
      gender: ALICE.gender,
      ethnicity: ALICE.ethnicity,
      physicalDescription: ALICE.physicalDescription,
      standardClothing: ALICE.standardClothing,
      distinguishingFeatures: ALICE.distinguishingFeatures,
      consistencyTag: ALICE.consistencyTag,
    });
    const live = await sheetHash({
      name: ALICE.name,
      age: ALICE.age,
      gender: ALICE.gender,
      ethnicity: ALICE.ethnicity,
      physicalDescription: 'short, red hair',
      standardClothing: ALICE.standardClothing,
      distinguishingFeatures: ALICE.distinguishingFeatures,
      consistencyTag: ALICE.consistencyTag,
    });
    expect(live).not.toBe(stamped);
  });
});

// ---------------------------------------------------------------------------
// Structure mutations (#1108 Phase 1) — the reorder-neutrality contract and
// the scene-metadata edges of §4.2.
// ---------------------------------------------------------------------------

describe('staleness matrix — structure mutations (§4.2, Phase 1)', () => {
  const hashScene = (scene: Scene) =>
    computeVisualPromptInputHash({
      scene,
      styleConfig: STYLE,
      characterBible: [ALICE],
      locationBible: [BEACH],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

  it('pure scene reorder (sceneNumber moves) changes NO prompt hash — the v5 contract', async () => {
    const before = await hashScene({ ...SCENE, sceneNumber: 1 });
    const after = await hashScene({ ...SCENE, sceneNumber: 5 });
    expect(after).toBe(before);
  });

  it('scene location / timeOfDay / storyBeat edits re-stale prompts; a title rename does not', async () => {
    const stamped = await hashScene(SCENE);
    const meta = SCENE.metadata;
    if (!meta) throw new Error('fixture scene must carry metadata');
    const retitled = await hashScene({
      ...SCENE,
      metadata: { ...meta, title: 'New title' },
    });
    expect(retitled).toBe(stamped);
    for (const mutation of [
      { ...meta, location: 'Harbor' },
      { ...meta, timeOfDay: 'night' },
      { ...meta, storyBeat: 'climax' },
    ]) {
      const live = await hashScene({ ...SCENE, metadata: mutation });
      expect(live).not.toBe(stamped);
    }
  });

  it('scene script edit re-stales prompts; duration edit does not', async () => {
    const stamped = await hashScene(SCENE);
    const scriptEdited = await hashScene({
      ...SCENE,
      originalScript: { extract: 'Alice sprints down the pier.', dialogue: [] },
    });
    expect(scriptEdited).not.toBe(stamped);

    const meta = SCENE.metadata;
    if (!meta) throw new Error('fixture scene must carry metadata');
    const durationEdited = await hashScene({
      ...SCENE,
      metadata: { ...meta, durationSeconds: 42 },
    });
    expect(durationEdited).toBe(stamped);
  });
});
