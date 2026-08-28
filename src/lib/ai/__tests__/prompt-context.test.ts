import { describe, expect, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { buildCastCharacterBible } from '@/lib/prompts/character-prompt';
import type {
  Character,
  SequenceElement,
  SequenceLocation,
  StyleConfig,
} from '@/lib/db/schema';
import {
  charactersToBible,
  sequenceElementsToBible,
  sequenceLocationsToBible,
} from '../bibles-from-scoped';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '../input-hash';
import { narrowShotPromptContext } from '../prompt-context';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '../scene-analysis.schema';

const style: StyleConfig = migrateStyleConfigV1ToV2({
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['neutral'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
});

const alice: CharacterBibleEntry = {
  characterId: 'alice',
  name: 'Alice',
  age: '30',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: '',
  distinguishingFeatures: '',
  consistencyTag: '',
};
const bob: CharacterBibleEntry = { ...alice, characterId: 'bob', name: 'Bob' };

const beach: LocationBibleEntry = {
  locationId: 'beach',
  name: 'Beach',
  type: 'exterior',
  timeOfDay: '',
  description: '',
  architecturalStyle: '',
  keyFeatures: '',
  colorPalette: '',
  lightingSetup: '',
  ambiance: '',
  consistencyTag: '',
  firstMention: { sceneId: '', text: '', lineNumber: 0 },
};
const forest: LocationBibleEntry = {
  ...beach,
  locationId: 'forest',
  name: 'Forest',
  firstMention: { sceneId: '', text: '', lineNumber: 0 },
};

const logo: ElementBibleEntry = {
  token: 'LOGO',
  description: 'Red hex logo',
  consistencyTag: 'red-hex-logo',
  firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
};
const bottle: ElementBibleEntry = {
  token: 'BOTTLE',
  description: 'Silver bottle',
  consistencyTag: 'silver-bottle',
  firstMention: { sceneId: 's1', text: 'BOTTLE', lineNumber: 1 },
};

function sceneReferencing(opts: {
  characterTags?: string[];
  environmentTag?: string;
  elementTags?: string[];
  script?: string;
  location?: string;
  durationSeconds?: number;
}): Scene {
  return {
    sceneId: 's1',
    sceneNumber: 1,
    originalScript: { extract: opts.script ?? '', dialogue: [] },
    metadata: {
      title: 'Test scene',
      durationSeconds: opts.durationSeconds ?? 5,
      location: opts.location ?? '',
      timeOfDay: '',
      storyBeat: '',
    },
    continuity: {
      characterTags: opts.characterTags ?? [],
      environmentTag: opts.environmentTag ?? '',
      elementTags: opts.elementTags ?? [],
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

describe('narrowShotPromptContext', () => {
  it('keeps only the character entries the scene references', () => {
    const ctx = {
      scene: sceneReferencing({ characterTags: ['alice'] }),
      styleConfig: style,
      characterBible: [alice, bob],
      locationBible: [],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowShotPromptContext(ctx);
    expect(narrowed.characterBible.map((c) => c.characterId)).toEqual([
      'alice',
    ]);
  });

  it('keeps only the location entries that match environmentTag or scene location', () => {
    const ctx = {
      scene: sceneReferencing({ environmentTag: 'beach' }),
      styleConfig: style,
      characterBible: [],
      locationBible: [beach, forest],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowShotPromptContext(ctx);
    expect(narrowed.locationBible.map((l) => l.locationId)).toEqual(['beach']);
  });

  it('keeps only the element entries this scene tags or mentions in its script', () => {
    const ctx = {
      scene: sceneReferencing({ elementTags: ['LOGO'] }),
      styleConfig: style,
      characterBible: [],
      locationBible: [],
      elementBible: [logo, bottle],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowShotPromptContext(ctx);
    expect(narrowed.elementBible.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('returns the full context unchanged when continuity is absent', () => {
    const ctx = {
      scene: {
        sceneId: 's1',
        sceneNumber: 1,
        originalScript: { extract: '', dialogue: [] },
      } as Scene,
      styleConfig: style,
      characterBible: [alice, bob],
      locationBible: [beach],
      elementBible: [logo],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowShotPromptContext(ctx);
    expect(narrowed).toEqual(ctx);
  });
});

describe('narrowed hash stability (the user-reported bug)', () => {
  const baseCtx = {
    scene: sceneReferencing({
      characterTags: ['alice'],
      environmentTag: 'beach',
      elementTags: ['LOGO'],
    }),
    styleConfig: style,
    characterBible: [alice],
    locationBible: [beach],
    elementBible: [logo],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
  };

  it('adding an unreferenced element does NOT change the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    // Simulate uploading a new element that no scene references yet.
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        elementBible: [logo, bottle],
      })
    );
    expect(after).toBe(before);
  });

  it('adding an unreferenced character does NOT change the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        characterBible: [alice, bob],
      })
    );
    expect(after).toBe(before);
  });

  it('adding an unreferenced location does NOT change the motion hash', async () => {
    const before = await computeMotionPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeMotionPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        locationBible: [beach, forest],
      })
    );
    expect(after).toBe(before);
  });

  it('referencing a new element via continuity tags DOES change the hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        elementBible: [logo, bottle],
      })
    );
    // Same bibles, but now the scene's continuity additionally references BOTTLE.
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        scene: sceneReferencing({
          characterTags: ['alice'],
          environmentTag: 'beach',
          elementTags: ['LOGO', 'BOTTLE'],
        }),
        elementBible: [logo, bottle],
      })
    );
    expect(after).not.toBe(before);
  });

  // Issue #767: motion-music-prompts-workflow snaps the duration mid-pipeline
  // (e.g. 7 → 8 for a model that only supports {5, 10}) and overwrites
  // `shot.metadata` after the visual prompt hash was already stored. The
  // visual hash must NOT care about that downstream parameter — duration is
  // hashed by `computeShotVideoInputHash` where it actually matters.
  it('changing metadata.durationSeconds does NOT change the visual hash', async () => {
    const continuityTags = {
      characterTags: ['alice'],
      environmentTag: 'beach',
      elementTags: ['LOGO'],
    };
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 7 }),
      })
    );
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 8 }),
      })
    );
    expect(after).toBe(before);
  });

  it('changing metadata.durationSeconds does NOT change the motion hash', async () => {
    const continuityTags = {
      characterTags: ['alice'],
      environmentTag: 'beach',
      elementTags: ['LOGO'],
    };
    const before = await computeMotionPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 7 }),
      })
    );
    const after = await computeMotionPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 8 }),
      })
    );
    expect(after).toBe(before);
  });
});

describe('prompt-driving projection (#867 §4.2)', () => {
  const baseCtx = {
    scene: sceneReferencing({
      characterTags: ['alice'],
      environmentTag: 'beach',
    }),
    styleConfig: style,
    characterBible: [alice],
    locationBible: [beach],
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
  };

  it('a consistencyTag change on a referenced character does NOT move the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        characterBible: [{ ...alice, consistencyTag: 'alice_recast_xyz' }],
      })
    );
    expect(after).toBe(before);
  });

  it('a firstMention change on a referenced location does NOT move the motion hash', async () => {
    const before = await computeMotionPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeMotionPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        locationBible: [
          {
            ...beach,
            firstMention: { sceneId: 's9', text: 'x', lineNumber: 42 },
          },
        ],
      })
    );
    expect(after).toBe(before);
  });

  it('a rename on a referenced location does NOT move the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        locationBible: [{ ...beach, name: 'The Shore' }],
      })
    );
    expect(after).toBe(before);
  });

  it('a rename on a referenced character does NOT move the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        characterBible: [{ ...alice, name: 'Alicia' }],
      })
    );
    expect(after).toBe(before);
  });

  it('a physicalDescription change on a referenced character DOES move the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowShotPromptContext(baseCtx)
    );
    const after = await computeVisualPromptInputHash(
      narrowShotPromptContext({
        ...baseCtx,
        characterBible: [{ ...alice, physicalDescription: 'now bearded' }],
      })
    );
    expect(after).not.toBe(before);
  });
});

describe('casting round-trip — stamp matches verify (#867)', () => {
  const rawSarah: CharacterBibleEntry = {
    characterId: 'char_001',
    name: 'Detective Sarah',
    age: '30s',
    gender: 'Female',
    ethnicity: 'Caucasian',
    physicalDescription: 'Tall, blonde hair, blue eyes',
    standardClothing: 'Dark trench coat',
    distinguishingFeatures: 'Scar on left cheek',
    consistencyTag: 'detective_sarah_blonde_30s',
  };
  const talentSheet: CharacterBibleEntry = {
    characterId: 'talent_1',
    name: 'Elvis Presley',
    age: '25',
    gender: 'Male',
    ethnicity: 'White',
    physicalDescription: 'Dark hair, sideburns, athletic build',
    standardClothing: 'White jumpsuit',
    distinguishingFeatures: 'Sideburns',
    consistencyTag: 'elvis_presley',
  };
  const match = {
    characterId: 'char_001',
    talentName: 'Elvis Presley',
    sheetMetadata: talentSheet,
  };
  // Scene references the character by name slug (matching is name-based, stable
  // across casting).
  const scene = sceneReferencing({
    characterTags: ['detective_sarah'],
    environmentTag: 'beach',
  });

  // Simulate the row the character-bible workflow persists, then read it back
  // the way `getShotStalenessFn` does at verify time.
  const makeCharacterRow = (b: CharacterBibleEntry): Character => ({
    id: `row_${b.characterId}`,
    sequenceId: 'seq_1',
    talentId: 'talent_1',
    characterId: b.characterId,
    name: b.name,
    age: b.age,
    gender: b.gender,
    ethnicity: b.ethnicity,
    physicalDescription: b.physicalDescription,
    standardClothing: b.standardClothing,
    distinguishingFeatures: b.distinguishingFeatures,
    consistencyTag: b.consistencyTag,
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    sheetImageUrl: null,
    sheetImagePath: null,
    sheetStatus: 'completed',
    sheetGeneratedAt: null,
    sheetError: null,
    sheetInputHash: null,
    selectedSheetVersionId: null,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const ctxWith = (characterBible: CharacterBibleEntry[]) =>
    narrowShotPromptContext({
      scene,
      styleConfig: style,
      characterBible,
      locationBible: [beach],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

  it('stamp (cast bible fed to prompt) equals verify (cast bible read from the DB)', async () => {
    const [castSarah] = buildCastCharacterBible([rawSarah], [match]);
    if (!castSarah) throw new Error('expected one cast entry');
    const verifyBible = charactersToBible([makeCharacterRow(castSarah)]);

    const stampHash = await computeVisualPromptInputHash(ctxWith([castSarah]));
    const verifyHash = await computeVisualPromptInputHash(ctxWith(verifyBible));
    expect(stampHash).toBe(verifyHash);
  });

  it('hashing the raw pre-cast bible (the old behaviour) diverged from the DB', async () => {
    const cast = buildCastCharacterBible([rawSarah], [match]);
    const rawHash = await computeVisualPromptInputHash(ctxWith([rawSarah]));
    const castHash = await computeVisualPromptInputHash(ctxWith(cast));
    // physicalDescription + age/gender/ethnicity differ between raw and cast, so
    // the pre-fix stamp could never match the cast DB row — permanent staleness.
    expect(rawHash).not.toBe(castHash);
  });

  // The MOTION child receives the same cast bible as the visual child
  // (analyze-script-workflow builds `castCharacterBible` once and feeds both).
  // Mirror the visual round-trip for motion so the motion stamp can't silently
  // regress to hashing the raw bible — that would make every talent-matched
  // shot's motion prompt permanently stale, exactly like the visual case.
  it('motion: stamp (cast bible) equals verify (cast bible read from the DB)', async () => {
    const [castSarah] = buildCastCharacterBible([rawSarah], [match]);
    if (!castSarah) throw new Error('expected one cast entry');
    const verifyBible = charactersToBible([makeCharacterRow(castSarah)]);

    const stampHash = await computeMotionPromptInputHash(ctxWith([castSarah]));
    const verifyHash = await computeMotionPromptInputHash(ctxWith(verifyBible));
    expect(stampHash).toBe(verifyHash);
  });

  it('motion: hashing the raw pre-cast bible diverged from the cast DB row', async () => {
    const cast = buildCastCharacterBible([rawSarah], [match]);
    const rawHash = await computeMotionPromptInputHash(ctxWith([rawSarah]));
    const castHash = await computeMotionPromptInputHash(ctxWith(cast));
    expect(rawHash).not.toBe(castHash);
  });
});

// Characters are aligned to the DB via `buildCastCharacterBible`; locations and
// elements have no such transform — the prompt STAMP hashes the raw scene-split
// bible while VERIFY hashes the DB readback (`sequenceLocationsToBible` /
// `sequenceElementsToBible`). Those readbacks coerce nulls/`type`, so a coercion
// that diverged from the raw bible's projected fields would resurrect the #867
// false-staleness for every location-/element-bearing shot. Pin the round-trip.
describe('location/element bible round-trip — stamp matches verify (#867)', () => {
  const scene = sceneReferencing({
    environmentTag: 'beach',
    elementTags: ['LOGO'],
    script: 'The LOGO glows on the beach.',
  });

  const ctxWith = (
    locationBible: LocationBibleEntry[],
    elementBible: ElementBibleEntry[]
  ) =>
    narrowShotPromptContext({
      scene,
      styleConfig: style,
      characterBible: [],
      locationBible,
      elementBible,
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

  const makeLocationRow = (l: LocationBibleEntry): SequenceLocation => ({
    id: `row_${l.locationId}`,
    sequenceId: 'seq_1',
    libraryLocationId: null,
    locationId: l.locationId,
    name: l.name,
    type: l.type,
    timeOfDay: l.timeOfDay,
    description: l.description,
    architecturalStyle: l.architecturalStyle,
    keyFeatures: l.keyFeatures,
    colorPalette: l.colorPalette,
    lightingSetup: l.lightingSetup,
    ambiance: l.ambiance,
    consistencyTag: l.consistencyTag,
    firstMentionSceneId: l.firstMention.sceneId || null,
    firstMentionText: l.firstMention.text || null,
    firstMentionLine: l.firstMention.lineNumber || null,
    referenceImageUrl: null,
    referenceImagePath: null,
    referenceStatus: 'completed',
    referenceGeneratedAt: null,
    referenceError: null,
    referenceInputHash: null,
    selectedReferenceVersionId: null,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const makeElementRow = (e: ElementBibleEntry): SequenceElement => ({
    id: `row_${e.token}`,
    sequenceId: 'seq_1',
    uploadedFilename: 'logo.png',
    token: e.token,
    description: e.description,
    consistencyTag: e.consistencyTag,
    imageUrl: 'https://example.com/logo.png',
    imagePath: 'elements/logo.png',
    visionStatus: 'completed',
    visionError: null,
    visionGeneratedAt: null,
    firstMentionSceneId: e.firstMention.sceneId || null,
    firstMentionText: e.firstMention.text || null,
    firstMentionLine: e.firstMention.lineNumber || null,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it.each(['interior', 'exterior', 'both'] as const)(
    'location: stamp == verify for a %s location (type coercion is faithful)',
    async (type) => {
      const stampLocation: LocationBibleEntry = {
        ...beach,
        type,
        timeOfDay: 'dawn',
        description: 'sand and surf',
        keyFeatures: 'pier, dunes',
      };
      const verifyBible = sequenceLocationsToBible([
        makeLocationRow(stampLocation),
      ]);
      const stamp = await computeVisualPromptInputHash(
        ctxWith([stampLocation], [])
      );
      const verify = await computeVisualPromptInputHash(
        ctxWith(verifyBible, [])
      );
      expect(stamp).toBe(verify);
    }
  );

  it('location: a firstMention/consistencyTag-only difference (raw stamp vs coerced DB row) does not move the hash', async () => {
    // Production reality: scene-split's raw bible carries a populated
    // firstMention; the DB row may have nulls → readback coerces to ''/0. Those
    // fields aren't projected, so the hashes must still match.
    const stampLocation: LocationBibleEntry = {
      ...beach,
      description: 'sand and surf',
      consistencyTag: 'beach_raw_tag',
      firstMention: { sceneId: 's9', text: 'the beach', lineNumber: 42 },
    };
    const dbReadback = sequenceLocationsToBible([
      makeLocationRow({
        ...stampLocation,
        consistencyTag: '',
        firstMention: { sceneId: '', text: '', lineNumber: 0 },
      }),
    ]);
    const stamp = await computeVisualPromptInputHash(
      ctxWith([stampLocation], [])
    );
    const verify = await computeVisualPromptInputHash(ctxWith(dbReadback, []));
    expect(stamp).toBe(verify);
  });

  it('element: stamp == verify through the DB readback', async () => {
    const verifyBible = sequenceElementsToBible([makeElementRow(logo)]);
    const stamp = await computeVisualPromptInputHash(ctxWith([], [logo]));
    const verify = await computeVisualPromptInputHash(ctxWith([], verifyBible));
    expect(stamp).toBe(verify);
  });

  it('element: a firstMention/consistencyTag-only difference does not move the hash', async () => {
    const dbReadback = sequenceElementsToBible([
      makeElementRow({
        ...logo,
        consistencyTag: '',
        firstMention: { sceneId: '', text: '', lineNumber: 0 },
      }),
    ]);
    const stamp = await computeVisualPromptInputHash(ctxWith([], [logo]));
    const verify = await computeVisualPromptInputHash(ctxWith([], dbReadback));
    expect(stamp).toBe(verify);
  });
});
