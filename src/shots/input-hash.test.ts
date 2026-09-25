import { describe, expect, expectTypeOf, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
  Scene,
} from './scene-analysis.schema';
import type { StyleConfig } from '@/platform/server/db/schema';
import type { MusicSceneSummary } from '@/platform/server/workflow/types';
import {
  characterSheetInputHashMatches,
  computeCharacterSheetInputHash,
  computeCharacterSheetInputHashLegacy,
  computeShotImageInputHash,
  computeLibraryLocationReferenceInputHash,
  computeLocationSheetInputHash,
  hashMotionPromptInput,
  computeMotionPromptInputHashV4,
  computeMusicPromptInputHash,
  LEGACY_HASH_UNTIL,
  computeSequenceMusicInputHash,
  computeTalentSheetInputHash,
  computeTalentSheetInputHashLegacy,
  assembleMotionPromptHashInput,
  hashVisualPromptInput,
  computeVisualPromptInputHashV4,
  motionPromptInputHashMatches,
  sha256Hex,
  shotImageInputHashMatches,
  visualPromptInputHashMatches,
  voiceOnlyMovedSince,
  type CharacterSheetHashInput,
  type MotionPromptHashInput,
  type MotionPromptInputHash,
  type ShotImageHashInput,
  type LibraryLocationReferenceHashInput,
  type LocationSheetHashInput,
  type TalentSheetHashInput,
} from './input-hash';
import { deriveShotDialogueLines, shotDialogue } from './shot-dialogue';
import { sceneForShot } from './server/shot-work-items';
import { replaceTokenInText } from '@/cast/cascade-rename';

const baseThumbnail: ShotImageHashInput = {
  kind: 'thumbnail',
  visualPrompt: 'A detective in a rainy alley, neon reflections',
  imageModel: 'flux-pro-v1.1',
  aspectRatio: '16:9',
  size: '1920x1080',
  seed: 42,
  characterSheetHashes: ['char-a', 'char-b'],
  locationSheetHashes: ['loc-1'],
  elementReferenceHashes: ['el-x'],
  elementTokens: [],
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Incomplete assembler payload for "omitted field throws" tests. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only incomplete DTO
const incomplete = <T>(value: object): T => value as T;

/** No character's voice-only flag moved since the stamp. */
const VOICE_STILL = { voiceOnlyMoved: false };

describe('computeShotImageInputHash (thumbnail)', () => {
  it('produces a 64-char hex SHA-256 digest', async () => {
    const hash = await computeShotImageInputHash(baseThumbnail);
    expect(hash).toMatch(SHA256_HEX);
  });

  it('returns the same hash for identical input', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({ ...baseThumbnail });
    expect(a).toBe(b);
  });

  it('is order-insensitive for character sheet refs', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-b', 'char-a'],
    });
    expect(a).toBe(b);
  });

  it('trims free-text prompts', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      visualPrompt: `   ${baseThumbnail.visualPrompt}\n`,
    });
    expect(a).toBe(b);
  });

  it('changes when the visual prompt changes', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      visualPrompt: `${baseThumbnail.visualPrompt} at dawn`,
    });
    expect(a).not.toBe(b);
  });

  it('changes when the image model version changes', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      imageModel: 'flux-pro-v1.2',
    });
    expect(a).not.toBe(b);
  });

  it('changes when the aspect ratio, size, or seed changes', async () => {
    const base = await computeShotImageInputHash(baseThumbnail);
    const aspect = await computeShotImageInputHash({
      ...baseThumbnail,
      aspectRatio: '9:16',
    });
    const size = await computeShotImageInputHash({
      ...baseThumbnail,
      size: '1280x720',
    });
    const seed = await computeShotImageInputHash({
      ...baseThumbnail,
      seed: 99,
    });
    expect(new Set([base, aspect, size, seed]).size).toBe(4);
  });

  it('changes when a referenced character sheet hash changes', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-a', 'char-b-NEW'],
    });
    expect(a).not.toBe(b);
  });

  it('changes when location or element refs change', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const loc = await computeShotImageInputHash({
      ...baseThumbnail,
      locationSheetHashes: ['loc-2'],
    });
    const el = await computeShotImageInputHash({
      ...baseThumbnail,
      elementReferenceHashes: ['el-y'],
    });
    expect(new Set([a, loc, el]).size).toBe(3);
  });

  it('rejects omitted size/seed; null is the explicit empty', async () => {
    const explicitNulls = await computeShotImageInputHash({
      ...baseThumbnail,
      size: null,
      seed: null,
    });
    expect(() =>
      computeShotImageInputHash(
        incomplete<ShotImageHashInput>({
          kind: baseThumbnail.kind,
          visualPrompt: baseThumbnail.visualPrompt,
          imageModel: baseThumbnail.imageModel,
          aspectRatio: baseThumbnail.aspectRatio,
          characterSheetHashes: baseThumbnail.characterSheetHashes,
          locationSheetHashes: baseThumbnail.locationSheetHashes,
          elementReferenceHashes: baseThumbnail.elementReferenceHashes,
        })
      )
    ).toThrow();
    expect(explicitNulls).toMatch(SHA256_HEX);
  });
});

describe('computeShotImageInputHash (variant-image)', () => {
  it('is distinct from the thumbnail hash for the same input', async () => {
    const thumb = await computeShotImageInputHash(baseThumbnail);
    const variant = await computeShotImageInputHash({
      ...baseThumbnail,
      kind: 'variant-image',
    });
    expect(variant).toMatch(SHA256_HEX);
    expect(variant).not.toBe(thumb);
  });

  it('is stable and sensitive to model change', async () => {
    const variantBase: ShotImageHashInput = {
      ...baseThumbnail,
      kind: 'variant-image',
    };
    const a = await computeShotImageInputHash(variantBase);
    const same = await computeShotImageInputHash({ ...variantBase });
    const different = await computeShotImageInputHash({
      ...variantBase,
      imageModel: 'sdxl-v1',
    });
    expect(a).toBe(same);
    expect(a).not.toBe(different);
  });
});

describe('computeCharacterSheetInputHash', () => {
  const base: CharacterSheetHashInput = {
    characterBible: {
      name: 'Detective Sarah',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'tall, blonde, blue eyes',
      standardClothing: 'dark trench coat',
      distinguishingFeatures: 'scar above right eye',
      consistencyTag: 'sarah_blonde_30s',
    },
    talentSheetHash: 'talent-sha',
    talent: null,
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('is stable and sensitive to visual bible field changes, not a rename', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const same = await computeCharacterSheetInputHash({ ...base });
    const renamed = await computeCharacterSheetInputHash({
      ...base,
      characterBible: { ...base.characterBible, name: 'Detective Linda' },
    });
    const look = await computeCharacterSheetInputHash({
      ...base,
      characterBible: {
        ...base.characterBible,
        physicalDescription: 'short, dark hair',
      },
    });
    expect(a).toBe(same);
    expect(a).toBe(renamed);
    expect(a).not.toBe(look);

    const named = await computeCharacterSheetInputHashLegacy(base);
    expect(named).not.toBe(a);
    expect(await characterSheetInputHashMatches(named, base)).toBe(true);
    expect(
      await characterSheetInputHashMatches(a, {
        ...base,
        characterBible: { ...base.characterBible, name: 'Detective Linda' },
      })
    ).toBe(true);
    expect(
      await characterSheetInputHashMatches(named, {
        ...base,
        characterBible: {
          ...base.characterBible,
          physicalDescription: 'short, dark hair',
        },
      })
    ).toBe(false);
  });

  it('reacts to talent hash, style config, and image model', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const talent = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: 'talent-sha-v2',
    });
    const style = await computeCharacterSheetInputHash({
      ...base,
      styleConfigHash: 'style-sha-v2',
    });
    const model = await computeCharacterSheetInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(new Set([a, talent, style, model]).size).toBe(4);
  });

  it('a cast talent edit re-stales the sheet; pre-#1785 digests still verify (#1785)', async () => {
    const cast: CharacterSheetHashInput = {
      ...base,
      talent: {
        description: 'Freckles, auburn hair',
        sheetImageUrl: '/r2/talent/sheet-1.png',
        sheetLook: {
          age: '30s',
          gender: 'female',
          ethnicity: '',
          physicalDescription: 'auburn hair',
        },
      },
    };
    const a = await computeCharacterSheetInputHash(cast);
    const talent = cast.talent;
    if (!talent?.sheetLook) throw new Error('fixture is cast');
    const edits = await Promise.all(
      [
        { ...talent, description: 'Freckles, grey hair' },
        { ...talent, sheetImageUrl: '/r2/talent/sheet-2.png' },
        {
          ...talent,
          sheetLook: { ...talent.sheetLook, physicalDescription: 'grey' },
        },
      ].map((t) => computeCharacterSheetInputHash({ ...cast, talent: t }))
    );
    expect(new Set([a, ...edits]).size).toBe(4);
    // Uncast digests do not move, and a sheet stamped before the talent
    // channel existed still verifies until LEGACY_HASH_UNTIL.
    expect(await computeCharacterSheetInputHash(base)).not.toBe(a);
    const preTalent = await computeCharacterSheetInputHash(base);
    expect(await characterSheetInputHashMatches(preTalent, cast)).toBe(true);
  });

  it('does not fold isPerson into the sheet hash (#1682)', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const flagged = await computeCharacterSheetInputHash({
      ...base,
      characterBible: {
        ...base.characterBible,
        isPerson: false,
      },
    });
    expect(flagged).toBe(a);
  });

  it('rejects omitted talentSheetHash; null is the explicit empty', async () => {
    const nullHash = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: null,
    });
    expect(() =>
      computeCharacterSheetInputHash(
        incomplete<CharacterSheetHashInput>({
          characterBible: base.characterBible,
          styleConfigHash: base.styleConfigHash,
          imageModel: base.imageModel,
        })
      )
    ).toThrow();
    expect(nullHash).toMatch(SHA256_HEX);
  });
});

describe('computeLocationSheetInputHash', () => {
  const base: LocationSheetHashInput = {
    locationBible: {
      name: 'Office',
      description: 'Modern open-plan, glass',
      type: 'interior',
      timeOfDay: 'day',
      architecturalStyle: 'modernist',
      keyFeatures: 'standing desks',
      colorPalette: 'white, steel',
      lightingSetup: 'fluorescent',
      ambiance: 'busy',
    },
    libraryLocationReferenceHash: 'lib-sha',
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('reacts to bible, library ref, style, and model', async () => {
    const a = await computeLocationSheetInputHash(base);
    const variants = await Promise.all([
      computeLocationSheetInputHash({
        ...base,
        locationBible: {
          ...base.locationBible,
          description: 'Warehouse, bare concrete',
        },
      }),
      computeLocationSheetInputHash({
        ...base,
        libraryLocationReferenceHash: 'lib-sha-v2',
      }),
      computeLocationSheetInputHash({
        ...base,
        styleConfigHash: 'style-sha-v2',
      }),
      computeLocationSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(new Set([a, ...variants]).size).toBe(5);
  });

  it('every bible field the sheet prompt reads re-stales it (#1785)', async () => {
    const a = await computeLocationSheetInputHash(base);
    const edits = await Promise.all(
      (
        [
          ['type', 'exterior'],
          ['timeOfDay', 'night'],
          ['architecturalStyle', 'brutalist'],
          ['keyFeatures', 'a single long table'],
          ['colorPalette', 'teal, orange'],
          ['lightingSetup', 'neon'],
          ['ambiance', 'deserted'],
        ] as const
      ).map(([field, value]) =>
        computeLocationSheetInputHash({
          ...base,
          locationBible: { ...base.locationBible, [field]: value },
        })
      )
    );
    expect(new Set([a, ...edits]).size).toBe(8);
  });

  it('a location rename does not change the sheet hash', async () => {
    const a = await computeLocationSheetInputHash(base);
    const renamed = await computeLocationSheetInputHash({
      ...base,
      locationBible: { ...base.locationBible, name: 'Warehouse' },
    });
    expect(renamed).toBe(a);
  });
});

describe('computeLibraryLocationReferenceInputHash', () => {
  const base: LibraryLocationReferenceHashInput = {
    locationBible: { name: 'Office', description: 'Modern open-plan, glass' },
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
    referenceMediaHashes: [],
  };

  it('is stable, distinct from sheet hash, and reacts to model', async () => {
    const ref = await computeLibraryLocationReferenceInputHash(base);
    const refSame = await computeLibraryLocationReferenceInputHash({ ...base });
    const sheetEquivalent = await computeLocationSheetInputHash({
      ...base,
      locationBible: {
        ...base.locationBible,
        type: 'interior',
        timeOfDay: '',
        architecturalStyle: '',
        keyFeatures: '',
        colorPalette: '',
        lightingSetup: '',
        ambiance: '',
      },
      libraryLocationReferenceHash: null,
    });
    const refModel = await computeLibraryLocationReferenceInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(ref).toBe(refSame);
    expect(ref).not.toBe(sheetEquivalent);
    expect(ref).not.toBe(refModel);
    expect(() =>
      computeLibraryLocationReferenceInputHash(
        incomplete<LibraryLocationReferenceHashInput>({
          locationBible: base.locationBible,
          styleConfigHash: base.styleConfigHash,
          imageModel: base.imageModel,
        })
      )
    ).toThrow();
  });
});

describe('computeTalentSheetInputHash', () => {
  const base: TalentSheetHashInput = {
    talent: { name: 'Talent Name', description: 'Headshot reference' },
    referenceMediaHashes: ['m1', 'm2', 'm3'],
    imageModel: 'flux-pro-v1.1',
  };

  it('is order-insensitive for reference media', async () => {
    const a = await computeTalentSheetInputHash(base);
    const b = await computeTalentSheetInputHash({
      ...base,
      referenceMediaHashes: ['m3', 'm1', 'm2'],
    });
    expect(a).toBe(b);
  });

  it('reacts to description, media set, and image model, not a rename', async () => {
    const a = await computeTalentSheetInputHash(base);
    const renamed = await computeTalentSheetInputHash({
      ...base,
      talent: { ...base.talent, name: 'Other Talent' },
    });
    const variants = await Promise.all([
      computeTalentSheetInputHash({
        ...base,
        talent: { ...base.talent, description: 'Full body reference' },
      }),
      computeTalentSheetInputHash({
        ...base,
        referenceMediaHashes: ['m1', 'm2', 'm4'],
      }),
      computeTalentSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(renamed).toBe(a);
    expect(new Set([a, ...variants]).size).toBe(4);
  });

  it('the pre-drop named talent digest differs from the current one', async () => {
    const named = await computeTalentSheetInputHashLegacy(base);
    expect(named).not.toBe(await computeTalentSheetInputHash(base));
  });
});

describe('canonical serialization', () => {
  it('produces the same digest regardless of key insertion order', async () => {
    const ordered = await computeCharacterSheetInputHash({
      characterBible: {
        name: 'Alice',
        age: '30s',
        gender: 'female',
        ethnicity: '',
        physicalDescription: 'tall',
        standardClothing: 'jacket',
        distinguishingFeatures: 'scar',
        consistencyTag: 'alice_30s',
      },
      talentSheetHash: 'talent',
      talent: null,
      styleConfigHash: 'style',
      imageModel: 'flux-pro',
    });
    // Same fields, declared in a different order at every level.
    const shuffled = await computeCharacterSheetInputHash({
      imageModel: 'flux-pro',
      styleConfigHash: 'style',
      talentSheetHash: 'talent',
      talent: null,
      characterBible: {
        consistencyTag: 'alice_30s',
        distinguishingFeatures: 'scar',
        standardClothing: 'jacket',
        physicalDescription: 'tall',
        ethnicity: '',
        gender: 'female',
        age: '30s',
        name: 'Alice',
      },
    });
    expect(ordered).toBe(shuffled);
  });

  it('rejects non-finite numbers rather than collapsing them to null', async () => {
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeSequenceMusicInputHash({
          prompt: 'test',
          tags: '',
          durationSeconds,
          audioModel: 'cassette-v1',
        })
      ).toThrow();
    }
  });
});

describe('prompt input hashes', () => {
  const minimalScene: Scene = {
    sceneId: 's1',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
  };

  const minimalStyle: StyleConfig = migrateStyleConfigV1ToV2({
    mood: 'neutral',
    artStyle: 'cinematic',
    lighting: 'natural',
    colorPalette: ['neutral'],
    cameraWork: 'static',
    referenceFilms: [],
    colorGrading: 'neutral',
  });

  const aliceCharacter: CharacterBibleEntry = {
    characterId: 'c1',
    name: 'Alice',
    age: '30',
    gender: '',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
    personality: '',
    movement: '',
    voiceDescription: '',
    voiceOnly: false,
    isPerson: true,
    consistencyTag: '',
  };

  const beachLocation: LocationBibleEntry = {
    locationId: 'l1',
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

  const sceneCtx = {
    scene: minimalScene,
    styleConfig: minimalStyle,
    characterBible: [aliceCharacter],
    locationBible: [beachLocation],
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    startingFrameImageUrl: null,
    referenceOnly: false,
    dialogue: { presence: false, lines: [] },
  };
  /** A shot whose lines sit on its dialogue node. */
  const NODE = { legacyScriptDialogue: false, ...VOICE_STILL };

  it('visual and motion prompt hashes are namespaced by artifact and differ', async () => {
    const visual = await hashVisualPromptInput(sceneCtx);
    const motion = await hashMotionPromptInput(sceneCtx);
    expect(visual).not.toBe(motion);
    expect(visual).toMatch(/^[0-9a-f]{64}$/);
    expect(motion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('motion prompt hash changes when the rendered starting frame changes (#929)', async () => {
    const baseline = await hashMotionPromptInput(sceneCtx);
    const withImage = await hashMotionPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/a.png',
    });
    const withReRenderedImage = await hashMotionPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/b.png',
    });
    // Absent vs present, and present-A vs present-B, must all differ so a
    // re-rendered still (new URL) re-stales the motion prompt.
    expect(withImage).not.toBe(baseline);
    expect(withReRenderedImage).not.toBe(withImage);
  });

  it('reference-only re-stales the motion prompt but never the visual one', async () => {
    const baseline = await hashMotionPromptInput(sceneCtx);
    const referenceOnly = await hashMotionPromptInput({
      ...sceneCtx,
      referenceOnly: true,
    });
    // The mode picks a different LLM template, so the prompt it produces for
    // the same scene is materially different.
    expect(referenceOnly).not.toBe(baseline);

    // The visual prompt produces the still; it cannot depend on whether one
    // gets rendered.
    expect(
      await hashVisualPromptInput({ ...sceneCtx, referenceOnly: true })
    ).toBe(await hashVisualPromptInput(sceneCtx));
  });

  it("the motion prompt hashes the shot's lines, not the script's; voices do not stale it (#1554, #1784)", async () => {
    // Voice identity binds on the clip (`audioSourceKey`), like a character
    // sheet on the still. The LLM never sees the ElevenLabs id or the bound
    // voice token, so neither may move the motion-prompt digest.
    const line = { character: 'Alice', line: 'Stay down.', tone: '' };
    const stayDown = { presence: true, lines: [line] };
    const withDialogue = { ...sceneCtx, dialogue: stayDown };
    expect(await hashMotionPromptInput(withDialogue)).not.toBe(
      await hashMotionPromptInput(sceneCtx)
    );
    // An edited line re-stales the prompt…
    expect(
      await hashMotionPromptInput({
        ...sceneCtx,
        dialogue: {
          presence: true,
          lines: [
            { character: 'Alice', line: 'Stay down.', tone: 'whispered' },
          ],
        },
      })
    ).not.toBe(await hashMotionPromptInput(withDialogue));
    // …a bound voice does not…
    expect(
      await hashMotionPromptInput({
        ...sceneCtx,
        dialogue: {
          presence: true,
          lines: [{ ...line, voiceToken: '@Audio1' }],
        },
      })
    ).toBe(await hashMotionPromptInput(withDialogue));
    // …and the script's own lines are not what the shot says.
    const scriptSaysOther = {
      ...minimalScene,
      originalScript: {
        extract: '',
        dialogue: [{ character: 'Alice', line: 'Run.', tone: '' }],
      },
    };
    expect(
      await hashMotionPromptInput({ ...withDialogue, scene: scriptSaysOther })
    ).toBe(await hashMotionPromptInput(withDialogue));
    // The visual prompt still reads the script.
    expect(
      await hashVisualPromptInput({ ...sceneCtx, scene: scriptSaysOther })
    ).not.toBe(await hashVisualPromptInput(sceneCtx));
  });

  it("keeps an unedited shot's stored motion digest (#1784)", async () => {
    // What `main` stamped before #1784, hashed over the SCRIPT's lines. A shot
    // whose node row holds the same lines hashes to the same digest now.
    const line = { character: 'Alice', line: 'Stay down.', tone: 'calm' };
    const ctx = {
      ...sceneCtx,
      scene: {
        ...minimalScene,
        originalScript: { extract: '', dialogue: [line] },
      },
      characterBible: [],
      locationBible: [],
      analysisModel: 'm',
      dialogue: { presence: true, lines: [line] },
    };
    expect(await hashMotionPromptInput(ctx)).toBe(
      '0821831a048411fcb78c904bcecad4befdfafbba0ced9b7a7090df87bacab534'
    );
  });

  it('the pipeline stamp matches the verify of the row scene-split seeds (#1784)', async () => {
    const lines = [
      { character: 'Alice', line: 'Run.', tone: 'urgent', shotNumber: 1 },
      { character: 'Bob', line: 'Where?', tone: '', shotNumber: 2 },
    ];
    const scene = {
      ...minimalScene,
      originalScript: { extract: '', dialogue: lines },
    };
    const base = { ...sceneCtx, characterBible: [], locationBible: [] };
    // The batch: the scene narrowed to shot 2, its lines as the dialogue.
    const narrowed = sceneForShot(scene, 2);
    const stamped = await hashMotionPromptInput({
      ...base,
      scene: narrowed,
      dialogue: shotDialogue(narrowed.originalScript.dialogue),
    });
    // Verify: the resolver reads the row scene-split seeded for shot 2.
    const seeded = deriveShotDialogueLines(lines, { shotNumber: 2 }, false);
    const verified = await hashMotionPromptInput({
      ...base,
      scene: narrowed,
      dialogue: shotDialogue(seeded),
    });
    expect(verified).toBe(stamped);
  });

  it('accepts a script-shaped digest only for a shot with no node row (#1784)', async () => {
    const script = {
      ...minimalScene,
      originalScript: {
        extract: '',
        dialogue: [{ character: 'Alice', line: 'Stay down.', tone: '' }],
      },
    };
    // Stamped before #1784: the script's lines were the shot's lines.
    const stamped = await hashMotionPromptInput({
      ...sceneCtx,
      scene: script,
      dialogue: {
        presence: true,
        lines: script.originalScript.dialogue,
      },
    });
    // Now the shot says something else.
    const now = {
      ...sceneCtx,
      scene: script,
      dialogue: {
        presence: true,
        lines: [{ character: 'Alice', line: 'Stay up.', tone: '' }],
      },
    };
    // No node row: the difference is the resolver's reading of old data
    // (unstamped lines, a pre-#1657 prompt row), not an edit. Still fresh.
    expect(
      await motionPromptInputHashMatches(stamped, now, {
        legacyScriptDialogue: true,
        voiceOnlyMoved: false,
      })
    ).toBe(true);
    // A node row: that is an edit, and it re-stales the prompt.
    expect(await motionPromptInputHashMatches(stamped, now, NODE)).toBe(false);
  });

  it('assembler rejects a missing referenceOnly channel (#1616)', () => {
    const { referenceOnly: _dropped, ...withoutFlag } = sceneCtx;
    expect(() => assembleMotionPromptHashInput(withoutFlag)).toThrow();
    expect(assembleMotionPromptHashInput(sceneCtx).referenceOnly).toBe(false);
  });

  it('branded digest is not a raw sha256 of {kind, text} (#1616)', async () => {
    const derived = await sha256Hex({
      kind: 'derived-shot-motion',
      shotId: 's1',
      text: 'move',
    });
    const assembler = await hashMotionPromptInput(sceneCtx);
    expect(assembler).not.toBe(derived);
    expectTypeOf(assembler).toEqualTypeOf<MotionPromptInputHash>();
    expectTypeOf<string>().not.toMatchTypeOf<MotionPromptInputHash>();
    expectTypeOf<
      Omit<MotionPromptHashInput, 'referenceOnly'>
    >().not.toMatchTypeOf<MotionPromptHashInput>();
  });

  it('leaves every stored image-to-video digest unchanged', async () => {
    // The flag joins the hash body only when true, so no existing row's
    // digest moves and no hash-version bump is needed.
    const omitted = await hashMotionPromptInput(sceneCtx);
    const explicitFalse = await hashMotionPromptInput({
      ...sceneCtx,
      referenceOnly: false,
    });
    expect(explicitFalse).toBe(omitted);
    expect(await motionPromptInputHashMatches(omitted, sceneCtx, NODE)).toBe(
      true
    );
  });

  it('personality / movement re-stale the motion prompt only, and only when set (#1561)', async () => {
    const withPerformance = {
      ...sceneCtx,
      characterBible: [
        { ...aliceCharacter, personality: 'guarded', movement: 'limps' },
      ],
    };
    // Motion reads them: gait and delivery change the prompt.
    expect(await hashMotionPromptInput(withPerformance)).not.toBe(
      await hashMotionPromptInput(sceneCtx)
    );
    // A still does not walk: the visual prompt ignores both.
    expect(await hashVisualPromptInput(withPerformance)).toBe(
      await hashVisualPromptInput(sceneCtx)
    );
    // Shape-stable: a character with neither hashes exactly as before the
    // fields existed, so no stored motion digest moves.
    const whitespace = {
      ...sceneCtx,
      characterBible: [{ ...aliceCharacter, personality: '  ', movement: '' }],
    };
    expect(await hashMotionPromptInput(whitespace)).toBe(
      await hashMotionPromptInput(sceneCtx)
    );
    // Pre-#1561 JSON (checkpoints, sheet metadata) has no keys at all.
    const { personality: _p, movement: _m, ...legacyAlice } = aliceCharacter;
    const legacy = {
      ...sceneCtx,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stored JSON that predates the fields
      characterBible: [legacyAlice as CharacterBibleEntry],
    };
    expect(await hashMotionPromptInput(legacy)).toBe(
      await hashMotionPromptInput(sceneCtx)
    );
  });

  it('omitting startingFrameImageUrl equals passing null (legacy shots)', async () => {
    const omitted = await hashMotionPromptInput(sceneCtx);
    const explicitNull = await hashMotionPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: null,
    });
    expect(omitted).toBe(explicitNull);
  });

  it('the visual prompt hash ignores the starting frame (it produces the image)', async () => {
    const baseline = await hashVisualPromptInput(sceneCtx);
    const withImage = await hashVisualPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/a.png',
    });
    expect(withImage).toBe(baseline);
  });

  it('bible array order does not affect the visual prompt hash', async () => {
    const second: CharacterBibleEntry = {
      ...aliceCharacter,
      characterId: 'c2',
      name: 'Bob',
    };
    const orderA = await hashVisualPromptInput({
      ...sceneCtx,
      characterBible: [aliceCharacter, second],
    });
    const orderB = await hashVisualPromptInput({
      ...sceneCtx,
      characterBible: [second, aliceCharacter],
    });
    expect(orderA).toBe(orderB);
  });

  // canonicalize() treats a repeated object reference as a cycle, so each
  // clone needs its own nested firstMention object.
  const cloneLocation = (
    overrides: Partial<LocationBibleEntry>
  ): LocationBibleEntry => ({
    ...beachLocation,
    ...overrides,
    firstMention: { sceneId: '', text: '', lineNumber: 0 },
  });

  it('locationBible order does not affect the visual prompt hash', async () => {
    const first = cloneLocation({});
    const second = cloneLocation({ locationId: 'l2', name: 'Forest' });
    const orderA = await hashVisualPromptInput({
      ...sceneCtx,
      locationBible: [first, second],
    });
    const orderB = await hashVisualPromptInput({
      ...sceneCtx,
      locationBible: [second, first],
    });
    expect(orderA).toBe(orderB);
  });

  it('elementBible order does not affect the visual prompt hash', async () => {
    const elementA = {
      token: 'LOGO',
      description: 'Red hex logo',
      consistencyTag: 'red-hex-logo',
      firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
    };
    const elementB = {
      token: 'BADGE',
      description: 'Police badge',
      consistencyTag: 'police-badge',
      firstMention: { sceneId: 's1', text: 'BADGE', lineNumber: 2 },
    };
    const orderA = await hashVisualPromptInput({
      ...sceneCtx,
      elementBible: [elementA, elementB],
    });
    const orderB = await hashVisualPromptInput({
      ...sceneCtx,
      elementBible: [elementB, elementA],
    });
    expect(orderA).toBe(orderB);
  });

  it('bible array order does not affect the motion prompt hash (all three bibles)', async () => {
    const characterA: CharacterBibleEntry = { ...aliceCharacter };
    const characterB: CharacterBibleEntry = {
      ...aliceCharacter,
      characterId: 'c2',
      name: 'Bob',
    };
    const locationA = cloneLocation({});
    const locationB = cloneLocation({ locationId: 'l2', name: 'Forest' });
    const elementA = {
      token: 'LOGO',
      description: 'Red hex logo',
      consistencyTag: 'red-hex-logo',
      firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
    };
    const elementB = {
      token: 'BADGE',
      description: 'Police badge',
      consistencyTag: 'police-badge',
      firstMention: { sceneId: 's1', text: 'BADGE', lineNumber: 2 },
    };
    const orderA = await hashMotionPromptInput({
      ...sceneCtx,
      characterBible: [characterA, characterB],
      locationBible: [locationA, locationB],
      elementBible: [elementA, elementB],
    });
    const orderB = await hashMotionPromptInput({
      ...sceneCtx,
      characterBible: [characterB, characterA],
      locationBible: [locationB, locationA],
      elementBible: [elementB, elementA],
    });
    expect(orderA).toBe(orderB);
  });

  it('a scene-title rename does not change the visual prompt stamp', async () => {
    const metadata = {
      title: 'Opening',
      durationSeconds: 5,
      location: 'INT. STUDIO',
      timeOfDay: 'night',
      storyBeat: 'establish',
    };
    const a = await hashVisualPromptInput({
      ...sceneCtx,
      scene: { ...minimalScene, metadata },
    });
    const b = await hashVisualPromptInput({
      ...sceneCtx,
      scene: { ...minimalScene, metadata: { ...metadata, title: 'Renamed' } },
    });
    expect(a).toBe(b);
  });

  it('dual-hash verify accepts a v4 visual digest of the same inputs', async () => {
    expect(LEGACY_HASH_UNTIL).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const current = await hashVisualPromptInput(sceneCtx);
    const v4 = await computeVisualPromptInputHashV4(sceneCtx);
    expect(v4).not.toBe(current);
    expect(
      await visualPromptInputHashMatches(current, sceneCtx, VOICE_STILL)
    ).toBe(true);
    expect(await visualPromptInputHashMatches(v4, sceneCtx, VOICE_STILL)).toBe(
      true
    );
    expect(
      await visualPromptInputHashMatches(
        v4,
        {
          ...sceneCtx,
          analysisModel: 'anthropic/claude-sonnet-4.6',
        },
        VOICE_STILL
      )
    ).toBe(false);
  });

  it('dual-hash verify accepts a v4 motion digest of the same inputs', async () => {
    const current = await hashMotionPromptInput(sceneCtx);
    const v4 = await computeMotionPromptInputHashV4(sceneCtx);
    expect(v4).not.toBe(current);
    expect(await motionPromptInputHashMatches(current, sceneCtx, NODE)).toBe(
      true
    );
    expect(await motionPromptInputHashMatches(v4, sceneCtx, NODE)).toBe(true);
    expect(
      await motionPromptInputHashMatches(
        v4,
        {
          ...sceneCtx,
          analysisModel: 'anthropic/claude-sonnet-4.6',
        },
        NODE
      )
    ).toBe(false);
  });

  it('changing the analysis model changes the visual prompt hash', async () => {
    const a = await hashVisualPromptInput(sceneCtx);
    const b = await hashVisualPromptInput({
      ...sceneCtx,
      analysisModel: 'anthropic/claude-sonnet-4.6',
    });
    expect(a).not.toBe(b);
  });

  it('elementBible changes flow through to both visual and motion prompt hashes', async () => {
    const withoutElements = sceneCtx;
    const withElement = {
      ...sceneCtx,
      elementBible: [
        {
          token: 'LOGO',
          description: 'Red hex logo',
          consistencyTag: 'red-hex-logo',
          firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
        },
      ],
    };

    const visualA = await hashVisualPromptInput(withoutElements);
    const visualB = await hashVisualPromptInput(withElement);
    const motionA = await hashMotionPromptInput(withoutElements);
    const motionB = await hashMotionPromptInput(withElement);

    expect(visualA).not.toBe(visualB);
    expect(motionA).not.toBe(motionB);
  });

  const baseSummary: MusicSceneSummary = {
    sceneId: 's1',
    title: 'Opening',
    storyBeat: 'Establish tone',
    durationSeconds: 10,
    location: 'INT. STUDIO - NIGHT',
    timeOfDay: 'night',
  };

  it('music prompt hash is stable for equivalent inputs and changes with sceneSummaries', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary }],
      analysisModel: 'm',
    });
    const c = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, storyBeat: 'Twist reveal' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('a scene-title rename does not change the music prompt stamp', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, title: 'Renamed opening' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
  });

  it('the scene id is not part of the music prompt stamp (#1783)', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, sceneId: 'row-id' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
  });

  it('hash excludes LLM output: same upstream context with different continuity hashes the same', async () => {
    // The generated prompts moved off the Scene shape entirely (#713), so the
    // only LLM-derived field still on the scene is `continuity` — confirm it is
    // excluded from both the visual and motion input hashes.
    const upstream = await hashVisualPromptInput(sceneCtx);
    const enriched = await hashVisualPromptInput({
      ...sceneCtx,
      scene: {
        ...minimalScene,
        continuity: {
          characterTags: ['alice'],
          environmentTag: 'beach',
          colorPalette: 'warm',
          lightingSetup: 'golden hour',
          styleTag: 'cinematic',
        },
      },
    });
    expect(upstream).toBe(enriched);

    const motionUpstream = await hashMotionPromptInput(sceneCtx);
    const motionEnriched = await hashMotionPromptInput({
      ...sceneCtx,
      scene: {
        ...minimalScene,
        continuity: {
          characterTags: ['alice'],
          environmentTag: 'beach',
          colorPalette: 'warm',
          lightingSetup: 'golden hour',
          styleTag: 'cinematic',
        },
      },
    });
    expect(motionUpstream).toBe(motionEnriched);
  });
});

describe('computeSequenceMusicInputHash', () => {
  const base = {
    prompt: 'Cinematic orchestral build',
    tags: 'cinematic,tension,strings',
    durationSeconds: 60,
    audioModel: 'cassette-v1',
  };

  it('is stable for identical input', async () => {
    const a = await computeSequenceMusicInputHash(base);
    const b = await computeSequenceMusicInputHash({ ...base });
    expect(a).toBe(b);
  });

  it('reacts to prompt, tags, duration, and model', async () => {
    const a = await computeSequenceMusicInputHash(base);
    const prompt = await computeSequenceMusicInputHash({
      ...base,
      prompt: 'Soft piano',
    });
    const tags = await computeSequenceMusicInputHash({
      ...base,
      tags: 'piano,calm',
    });
    const duration = await computeSequenceMusicInputHash({
      ...base,
      durationSeconds: 90,
    });
    const model = await computeSequenceMusicInputHash({
      ...base,
      audioModel: 'cassette-v2',
    });
    expect(new Set([a, prompt, tags, duration, model]).size).toBe(5);
  });

  it('trims leading/trailing whitespace on prompt and tags', async () => {
    const trimmed = await computeSequenceMusicInputHash(base);
    const padded = await computeSequenceMusicInputHash({
      ...base,
      prompt: '  Cinematic orchestral build  ',
      tags: '\tcinematic,tension,strings\n',
    });
    expect(padded).toBe(trimmed);
  });
});

describe('voiceOnlyMovedSince (#1787)', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const v = (characterId: string, voiceOnly: boolean, minutes: number) => ({
    characterId,
    voiceOnly,
    createdAt: new Date(at.getTime() + minutes * 60_000),
  });

  it('a flip after the stamp moved; a first version or an earlier flip did not', () => {
    expect(voiceOnlyMovedSince([v('a', false, -2), v('a', true, 1)], at)).toBe(
      true
    );
    expect(voiceOnlyMovedSince([v('a', true, 1)], at)).toBe(false);
    expect(voiceOnlyMovedSince([v('a', false, -2), v('a', true, -1)], at)).toBe(
      false
    );
    // Another character's first version is not a flip of this one.
    expect(voiceOnlyMovedSince([v('a', false, -2), v('b', true, 1)], at)).toBe(
      false
    );
  });
});

describe('an element token is a label (#1827)', () => {
  const rename = (text: string) => replaceTokenInText(text, 'LAMP', 'LANTERN');
  const style = migrateStyleConfigV1ToV2({
    mood: 'neutral',
    artStyle: 'cinematic',
    lighting: 'natural',
    colorPalette: ['neutral'],
    cameraWork: 'static',
    referenceFilms: [],
    colorGrading: 'neutral',
  });
  const lamp = {
    token: 'LAMP',
    description: 'Brass oil lamp',
    consistencyTag: 'brass-lamp',
    firstMention: { sceneId: 's1', text: 'LAMP', lineNumber: 1 },
  };
  const ctx = {
    scene: {
      sceneId: 's1',
      sceneNumber: 1,
      originalScript: { extract: 'Alice lifts the LAMP.', dialogue: [] },
    } satisfies Scene,
    styleConfig: style,
    characterBible: [],
    locationBible: [],
    elementBible: [lamp],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    startingFrameImageUrl: null,
    referenceOnly: false,
    dialogue: { presence: false, lines: [] },
  };
  // What `cascadeRename` leaves behind: the script and the element row renamed.
  const renamed = {
    ...ctx,
    scene: {
      ...ctx.scene,
      originalScript: {
        extract: rename(ctx.scene.originalScript.extract),
        dialogue: [],
      },
    },
    elementBible: [{ ...lamp, token: 'LANTERN' }],
  };
  // Stamped by the code before #1827, for the same `ctx`.
  const PRE_1827_VISUAL =
    '5c96256639d98d522ab58c65bca08f8f5604fead092138ce84ec3afbc6768aa1';
  const PRE_1827_MOTION =
    '7ae1498cd6855f1fc4dbd5d49813863057a9a77ada41e916765fdb73735908b0';
  const NODE = { legacyScriptDialogue: false, voiceOnlyMoved: false };
  const UNMOVED = { voiceOnlyMoved: false };

  it('a rename leaves the visual and motion prompt stamps fresh', async () => {
    const visual = await hashVisualPromptInput(ctx);
    const motion = await hashMotionPromptInput(ctx);
    expect(await hashVisualPromptInput(renamed)).toBe(visual);
    expect(await hashMotionPromptInput(renamed)).toBe(motion);
  });

  it('a description edit or a different element named still stales both', async () => {
    const described = {
      ...ctx,
      elementBible: [{ ...lamp, description: 'Green glass lamp' }],
    };
    const badge = {
      ...lamp,
      token: 'BADGE',
      description: 'Police badge',
    };
    const twoElements = { ...ctx, elementBible: [lamp, badge] };
    const namesBadge = {
      ...twoElements,
      scene: {
        ...ctx.scene,
        originalScript: { extract: 'Alice lifts the BADGE.', dialogue: [] },
      },
    };
    expect(await hashVisualPromptInput(described)).not.toBe(
      await hashVisualPromptInput(ctx)
    );
    expect(await hashMotionPromptInput(described)).not.toBe(
      await hashMotionPromptInput(ctx)
    );
    expect(await hashVisualPromptInput(namesBadge)).not.toBe(
      await hashVisualPromptInput(twoElements)
    );
    expect(await hashMotionPromptInput(namesBadge)).not.toBe(
      await hashMotionPromptInput(twoElements)
    );
  });

  it('a pre-#1827 prompt digest still verifies until the inputs move', async () => {
    expect(
      await visualPromptInputHashMatches(PRE_1827_VISUAL, ctx, UNMOVED)
    ).toBe(true);
    expect(await motionPromptInputHashMatches(PRE_1827_MOTION, ctx, NODE)).toBe(
      true
    );
    // A rename made before deploy is the one case that still reads stale.
    expect(
      await visualPromptInputHashMatches(PRE_1827_VISUAL, renamed, UNMOVED)
    ).toBe(false);
  });

  const still: ShotImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: 'Alice raises the LAMP over the LAMPLIGHTER sign',
    imageModel: 'nano_banana_2',
    aspectRatio: '16:9',
    size: null,
    seed: null,
    characterSheetHashes: [],
    locationSheetHashes: [],
    elementReferenceHashes: ['https://r2/lamp.png'],
    elementTokens: [{ token: 'LAMP', id: 'el-1' }],
  };
  const renamedStill: ShotImageHashInput = {
    ...still,
    visualPrompt: rename(still.visualPrompt),
    elementTokens: [{ token: 'LANTERN', id: 'el-1' }],
  };

  it('a rename leaves the still stamp fresh', async () => {
    expect(renamedStill.visualPrompt).toContain('LAMPLIGHTER');
    expect(await computeShotImageInputHash(renamedStill)).toBe(
      await computeShotImageInputHash(still)
    );
  });

  it('a new element image, or a prompt edit, still stales the still', async () => {
    const stamp = await computeShotImageInputHash(still);
    expect(
      await computeShotImageInputHash({
        ...renamedStill,
        elementReferenceHashes: ['https://r2/lamp-v2.png'],
      })
    ).not.toBe(stamp);
    expect(
      await computeShotImageInputHash({
        ...still,
        visualPrompt: 'Alice drops the LAMP',
      })
    ).not.toBe(stamp);
  });

  it('a pre-#1827 still digest still verifies', async () => {
    // Before #1827 the still hashed its prompt raw — the digest an input
    // with no elements produces today.
    const legacy = await computeShotImageInputHash({
      ...still,
      elementTokens: [],
    });
    expect(legacy).not.toBe(await computeShotImageInputHash(still));
    expect(await shotImageInputHashMatches(legacy, still)).toBe(true);
    expect(await shotImageInputHashMatches(legacy, renamedStill)).toBe(false);
  });
});
