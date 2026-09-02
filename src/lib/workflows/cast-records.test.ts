import { describe, expect, test, vi } from 'vitest';
import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
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
