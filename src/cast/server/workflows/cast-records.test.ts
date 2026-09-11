import { describe, expect, test, vi } from 'vitest';
import type { ElementBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { createCastRecords, findMissingElementEntries } from './cast-records';

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

describe('createCastRecords', () => {
  test('creates cast and locations pending, and image-less element rows', async () => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    const locationCreateBulk = vi.fn(async (rows: unknown[]) => rows);
    const elementCreate = vi.fn(async (row: Record<string, unknown>) => row);
    const getByToken = vi.fn(async () => null);
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub
    const scopedDb = {
      characters: { create: characterCreate },
      sequenceLocations: { createBulk: locationCreateBulk },
      sequenceElements: { create: elementCreate },
      liveRead: { sequenceElements: { getByToken } },
    } as unknown as WorkflowScopedDb;

    const result = await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      characterBible: [
        {
          characterId: 'char_1',
          name: 'Sarah',
          age: '30s',
          gender: 'female',
          ethnicity: '',
          physicalDescription: 'tall',
          standardClothing: 'coat',
          distinguishingFeatures: '',
          personality: '',
          movement: '',
          voiceOnly: false,
          consistencyTag: 'sarah',
        },
      ],
      talentMatches: [],
      locationMatches: [],
      locationBible: [
        {
          locationId: 'loc_1',
          name: 'INT. CAFE - DAY',
          type: 'interior',
          timeOfDay: 'day',
          description: 'a cafe',
          architecturalStyle: '',
          keyFeatures: '',
          colorPalette: '',
          lightingSetup: '',
          ambiance: '',
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
      expect.objectContaining({ characterId: 'char_1', sheetStatus: 'pending' })
    );
    expect(locationCreateBulk.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        locationId: 'loc_1',
        referenceStatus: 'pending',
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
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub
    const scopedDb = {
      characters: { create: vi.fn() },
      sequenceLocations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: elementCreate },
      liveRead: {
        sequenceElements: { getByToken: vi.fn(async () => existing) },
      },
    } as unknown as WorkflowScopedDb;

    const result = await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      characterBible: [],
      talentMatches: [],
      locationBible: [],
      locationMatches: [],
      elementBible: [entry('BOTTLE')],
      existingElements: [],
    });

    expect(elementCreate).not.toHaveBeenCalled();
    expect(result.elements).toEqual([existing]);
  });
});

describe('createCastRecords (talent match, #1561)', () => {
  const sarah = {
    characterId: 'char_1',
    name: 'Sarah',
    age: '30s',
    gender: 'female',
    ethnicity: '',
    physicalDescription: 'tall',
    standardClothing: 'coat',
    distinguishingFeatures: '',
    personality: 'anxious',
    movement: 'restless hands',
    voiceOnly: false,
    consistencyTag: 'sarah',
  };
  const match = {
    voiceId: null,
    voiceDescription: null,
    characterId: 'char_1',
    talentId: 'tal_1',
    talentName: 'Ada',
    sheetImageUrl: '/r2/ada.png',
  };

  const run = async (personality: string, movement: string) => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub
    const scopedDb = {
      characters: { create: characterCreate },
      sequenceLocations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: vi.fn() },
      liveRead: { sequenceElements: { getByToken: vi.fn(async () => null) } },
    } as unknown as WorkflowScopedDb;
    await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      characterBible: [sarah],
      talentMatches: [{ ...match, personality, movement }],
      locationBible: [],
      locationMatches: [],
      elementBible: [],
      existingElements: [],
    });
    return characterCreate.mock.calls[0]?.[0];
  };

  test("the talent's own performance wins", async () => {
    expect(await run('swaggering', 'hip swivel')).toMatchObject({
      talentId: 'tal_1',
      personality: 'swaggering',
      movement: 'hip swivel',
    });
  });

  test("a talent with none keeps the script's", async () => {
    expect(await run('', '')).toMatchObject({
      personality: 'anxious',
      movement: 'restless hands',
    });
  });
});

describe('createCastRecords (voice only, #1585)', () => {
  test('a narrator persists with voiceOnly true and no talent', async () => {
    const characterCreate = vi.fn(async (row: { id: string }) => row);
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub
    const scopedDb = {
      characters: { create: characterCreate },
      sequenceLocations: { createBulk: vi.fn(async () => []) },
      sequenceElements: { create: vi.fn() },
      liveRead: { sequenceElements: { getByToken: vi.fn(async () => null) } },
    } as unknown as WorkflowScopedDb;
    await createCastRecords(scopedDb, {
      sequenceId: 'seq_1',
      characterBible: [
        {
          characterId: 'narrator',
          name: 'Narrator',
          age: '',
          gender: '',
          ethnicity: '',
          physicalDescription: '',
          standardClothing: '',
          distinguishingFeatures: '',
          personality: 'dry, unhurried, faintly amused',
          movement: '',
          voiceOnly: true,
          consistencyTag: 'narrator',
        },
      ],
      talentMatches: [],
      locationBible: [],
      locationMatches: [],
      elementBible: [],
      existingElements: [],
    });
    expect(characterCreate.mock.calls[0]?.[0]).toMatchObject({
      characterId: 'narrator',
      voiceOnly: true,
      sheetStatus: 'pending',
      talentId: null,
    });
  });
});
