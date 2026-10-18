import { describe, expect, test, vi } from 'vitest';
import type { ElementBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  buildLocationInsert,
  createCastRecords,
  findMissingElementEntries,
} from './cast-records';
import { asStub } from '@/test/as-stub';

const entry = (token: string): ElementBibleEntry => ({
  token,
  description: `Visual description of ${token}`,
  consistencyTag: token.toLowerCase().replaceAll('_', '-'),
  firstMention: { sceneId: 'scene_1', text: `the ${token}`, lineNumber: 1 },
});

describe('findMissingElementEntries', () => {
  test('skips tokens that already have a reference image', () => {
    const bible = [entry('LOGO'), entry('CORAL_LIPSTICK')];

    const missing = findMissingElementEntries(bible, [
      { id: 'el_logo', token: 'LOGO', imageUrl: 'https://x/logo.png' },
    ]);

    expect(missing.map((e) => e.token)).toEqual(['CORAL_LIPSTICK']);
  });

  test('reuses the id of a Script-stage placeholder (no image yet)', () => {
    const missing = findMissingElementEntries(
      [entry('LOGO')],
      [{ id: 'el_logo', token: 'LOGO', imageUrl: null }]
    );

    expect(missing).toEqual([{ ...entry('LOGO'), elementId: 'el_logo' }]);
  });

  test('allocates an id when there is no row at all', () => {
    const [missing] = findMissingElementEntries([entry('HERO')], []);

    expect(missing?.elementId).toMatch(/^[0-9A-Z]{26}$/);
  });

  test('is exact-match on token (no case folding)', () => {
    const missing = findMissingElementEntries(
      [entry('LOGO')],
      [{ id: 'x', token: 'logo', imageUrl: 'https://x/logo.png' }]
    );

    expect(missing.map((e) => e.token)).toEqual(['LOGO']);
  });

  test('caps at MAX_AUTO_ELEMENTS so no placeholder outlives the sheet pass', () => {
    const bible = ['A', 'B', 'C', 'D', 'E'].map(entry);

    const missing = findMissingElementEntries(bible, []);

    expect(missing.map((e) => e.token)).toEqual(['A', 'B', 'C']);
  });
});

// Each analysed look lands on a `character_looks` row (#2015); the stub
// answers with the id the look was given.
const syncFromAnalysis = vi.fn(
  async (
    _sequenceId: string,
    characterId: string,
    looks: { lookId: string }[]
  ) =>
    Object.fromEntries(
      looks.map((look, i) => [
        look.lookId,
        i === 0 ? characterId : `db-${look.lookId}`,
      ])
    )
);

describe('createCastRecords', () => {
  test('creates cast and locations pending, and image-less element rows', async () => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    const locationCreateBulk = vi.fn(async (rows: unknown[]) => rows);
    const elementCreate = vi.fn(async (row: Record<string, unknown>) => row);
    const getByToken = vi.fn(async () => null);
    // minimal stub
    const scopedDb = asStub<WorkflowScopedDb>({
      characters: { create: characterCreate },
      characterLooks: { syncFromAnalysis },
      locations: { createBulk: locationCreateBulk },
      sequenceElements: { create: elementCreate },
      liveRead: { sequenceElements: { getByToken } },
    });

    const result = await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      cast: [],
      characterBible: [
        {
          characterId: 'char_1',
          name: 'Sarah',
          age: '30s',
          gender: 'female',
          ethnicity: '',
          physicalDescription: 'tall',
          standardClothing: 'coat',
          looks: [],
          personality: '',
          movement: '',
          voiceDescription: '',
          voiceOnly: false,
          isPerson: true,
          rendering: 'Photoreal live action',
          consistencyTag: 'sarah',
        },
      ],
      locationMatches: [],
      locationBible: [
        {
          locationId: 'loc_1',
          name: 'INT. CAFE - DAY',
          type: 'interior',
          description: 'a cafe',
          architecturalStyle: '',
          keyFeatures: '',
          ambiance: '',
          rendering: 'Photoreal live action',
          consistencyTag: 'cafe',
          firstMention: {
            sceneId: 'scene_1',
            text: 'INT. CAFE',
            lineNumber: 1,
          },
        },
      ],
      elementBible: [entry('LOGO'), entry('BOTTLE')],
      existingElements: [
        { id: 'el_logo', token: 'LOGO', imageUrl: 'https://x/logo.png' },
      ],
    });

    expect(characterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: 'char_1',
        sheetStatus: 'pending',
      }),
      { source: 'analysis', createdBy: null }
    );
    expect(locationCreateBulk.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        locationId: 'loc_1',
        referenceStatus: 'pending',
        rendering: 'Photoreal live action',
        // Not matched to a team location: analysis makes it here.
        boundTo: null,
      }),
    ]);
    // LOGO already has an image; only BOTTLE gets a placeholder row.
    expect(elementCreate).toHaveBeenCalledTimes(1);
    expect(elementCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'BOTTLE',
        imageUrl: null,
        visionStatus: 'completed',
      })
    );
    expect(result.elements.map((e) => e.token)).toEqual(['BOTTLE']);
  });

  test('reuses a row that landed between the token check and the insert', async () => {
    const existing = {
      id: 'el_raced',
      token: 'BOTTLE',
      description: null,
      imageUrl: null,
      consistencyTag: null,
    };
    const elementCreate = vi.fn();
    // minimal stub
    const scopedDb = asStub<WorkflowScopedDb>({
      characters: { create: vi.fn() },
      locations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: elementCreate },
      liveRead: {
        sequenceElements: { getByToken: vi.fn(async () => existing) },
      },
    });

    const result = await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      cast: [],
      characterBible: [],
      locationBible: [],
      locationMatches: [],
      elementBible: [entry('BOTTLE')],
      existingElements: [],
    });

    expect(elementCreate).not.toHaveBeenCalled();
    expect(result.elements).toEqual([existing]);
  });
});

describe('createCastRecords (attached cast, #2050)', () => {
  // A persisted look id, as the snapshot carries them.
  const LOOK_ROW = '01HF5Z8XKQYC5N8Z3KQXR6TBQM';
  const sarah = {
    characterId: 'char_sarah',
    name: 'Sarah',
    age: '30s',
    gender: 'female',
    ethnicity: '',
    physicalDescription: 'tall',
    standardClothing: 'coat',
    looks: [
      { lookId: LOOK_ROW, name: 'Default', clothing: 'coat', styling: '' },
      {
        lookId: 'char_sarah:gala',
        name: 'Gala',
        clothing: 'gown',
        styling: '',
      },
    ],
    distinguishingFeatures: '',
    personality: '',
    movement: '',
    voiceDescription: '',
    voiceOnly: false,
    isPerson: true,
    rendering: 'Photoreal live action',
    consistencyTag: 'sarah',
  };

  const run = async (shared: boolean) => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    const linkFromAnalysis = vi.fn(
      async (_s: string, _c: string, looks: { lookId: string }[]) =>
        Object.fromEntries(looks.map((l) => [l.lookId, `linked-${l.lookId}`]))
    );
    // minimal stub
    const scopedDb = asStub<WorkflowScopedDb>({
      characters: { create: characterCreate },
      characterLooks: { syncFromAnalysis, linkFromAnalysis },
      locations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: vi.fn() },
      liveRead: { sequenceElements: { getByToken: vi.fn(async () => null) } },
    });
    const result = await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      cast: [{ id: 'row-sarah', shared, entry: sarah }],
      characterBible: [sarah],
      locationBible: [],
      locationMatches: [],
      elementBible: [],
      existingElements: [],
    });
    return { result, characterCreate, linkFromAnalysis };
  };

  test('a shared character is linked, never written: no create, looks linked by id and name', async () => {
    const { result, characterCreate, linkFromAnalysis } = await run(true);
    expect(characterCreate).not.toHaveBeenCalled();
    expect(linkFromAnalysis).toHaveBeenCalledWith(
      'seq_1',
      'row-sarah',
      sarah.looks
    );
    expect(result.lookIds).toEqual({
      [LOOK_ROW]: `linked-${LOOK_ROW}`,
      'char_sarah:gala': 'linked-char_sarah:gala',
    });
  });

  test('a character only this sequence holds takes the re-analysis as before', async () => {
    const { characterCreate, linkFromAnalysis } = await run(false);
    expect(characterCreate).toHaveBeenCalledTimes(1);
    expect(linkFromAnalysis).not.toHaveBeenCalled();
  });
});

describe('createCastRecords (voice only, #1585)', () => {
  test('a narrator persists with voiceOnly true', async () => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    // minimal stub
    const scopedDb = asStub<WorkflowScopedDb>({
      characters: { create: characterCreate },
      characterLooks: { syncFromAnalysis },
      locations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: vi.fn() },
      liveRead: { sequenceElements: { getByToken: vi.fn(async () => null) } },
    });
    await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      cast: [],
      characterBible: [
        {
          characterId: 'narrator',
          name: 'Narrator',
          age: '',
          gender: '',
          ethnicity: '',
          physicalDescription: '',
          standardClothing: '',
          looks: [],
          personality: 'dry, unhurried, faintly amused',
          movement: '',
          voiceDescription: '',
          voiceOnly: true,
          isPerson: true,
          rendering: '',
          consistencyTag: 'narrator',
        },
      ],
      locationBible: [],
      locationMatches: [],
      elementBible: [],
      existingElements: [],
    });
    expect(characterCreate.mock.calls[0]?.[0]).toMatchObject({
      characterId: 'narrator',
      voiceDescription: null,
      voiceOnly: true,
      isPerson: true,
      rendering: null,
      sheetStatus: 'pending',
    });
  });

  test('persists the bible Voice Design brief', async () => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    // minimal stub
    const scopedDb = asStub<WorkflowScopedDb>({
      characters: { create: characterCreate },
      characterLooks: { syncFromAnalysis },
      locations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: vi.fn() },
      liveRead: { sequenceElements: { getByToken: vi.fn(async () => null) } },
    });
    await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      cast: [],
      characterBible: [
        {
          characterId: 'narrator',
          name: 'Narrator',
          age: '',
          gender: '',
          ethnicity: '',
          physicalDescription: '',
          standardClothing: '',
          looks: [],
          personality: 'dry, unhurried, faintly amused',
          movement: '',
          voiceDescription:
            'Native English. Male, 50s. Excellent quality. Persona: dry narrator. Emotion: unhurried, amused. Warm low timbre, conversational pace.',
          voiceOnly: true,
          isPerson: true,
          rendering: 'Photoreal live action',
          consistencyTag: 'narrator',
        },
      ],
      locationBible: [],
      locationMatches: [],
      elementBible: [],
      existingElements: [],
    });
    expect(characterCreate.mock.calls[0]?.[0]).toMatchObject({
      voiceDescription:
        'Native English. Male, 50s. Excellent quality. Persona: dry narrator. Emotion: unhurried, amused. Warm low timbre, conversational pace.',
    });
  });
});

describe('buildLocationInsert (#1695)', () => {
  const location = {
    locationId: 'loc_1',
    name: 'INT. CAFE - DAY',
    type: 'interior' as const,
    description: 'a cafe',
    architecturalStyle: '',
    keyFeatures: '',
    ambiance: '',
    rendering: '3D animated, Pixar-like',
    consistencyTag: 'cafe',
    firstMention: { sceneId: 'scene_1', text: 'INT. CAFE', lineNumber: 4 },
  };

  test('a script location matching bound to a team location is linked to it', () => {
    expect(
      buildLocationInsert({
        sequenceId: 'seq_1',
        location,
        libraryMatch: {
          locationId: 'loc_1',
          libraryLocationId: 'team-loc-9',
          libraryLocationName: 'Team Cafe',
          referenceImageUrl: '/r2/team/cafe.png',
        },
        referenceStatus: 'pending',
      })
    ).toMatchObject({
      sequenceId: 'seq_1',
      locationId: 'loc_1',
      boundTo: 'team-loc-9',
      firstMentionSceneId: 'scene_1',
      firstMentionLine: 4,
    });
  });

  test('an unmatched one carries its bible, rendering included, and binds nothing', () => {
    expect(
      buildLocationInsert({
        sequenceId: 'seq_1',
        location,
        libraryMatch: undefined,
        referenceStatus: 'generating',
      })
    ).toMatchObject({
      name: 'INT. CAFE - DAY',
      rendering: '3D animated, Pixar-like',
      referenceStatus: 'generating',
      boundTo: null,
    });
  });
});
