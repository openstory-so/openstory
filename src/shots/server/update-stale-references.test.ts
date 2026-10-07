import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Character, Sequence } from '@/platform/server/db/schema';
import { buildPlanReferences } from './update-stale-references';
import { asStub } from '@/test/as-stub';

const { buildSheet, estimateSheets } = vi.hoisted(() => ({
  buildSheet: vi.fn(),
  estimateSheets: vi.fn(
    ({ characterSheets }: { characterSheets: number }) => characterSheets * 100
  ),
}));
vi.mock('@/cast/server/sheets/character-sheet-trigger', () => ({
  buildRegenerateCharacterSheetPayload: buildSheet,
}));
vi.mock('@/cast/server/sheets/location-sheet-trigger', () => ({
  buildRegenerateLocationSheetPayload: vi.fn(),
}));
vi.mock('@/billing/cost-estimation', () => ({
  estimateReferenceSheetCost: estimateSheets,
}));
vi.mock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
vi.mock('@/models/server/seed-speech-config', () => ({
  newVoiceProvider: () => 'elevenlabs',
}));

async function references(
  overrides: Partial<Character> = {},
  units: { kind: 'sheet:character'; id: string }[] = [
    { kind: 'sheet:character', id: 'maya' },
  ]
) {
  // only these character fields are consumed; payload construction is mocked.
  // A `sheet:character` unit names a look (#2015); the default look's id is
  // the character's, and here she wears it.
  const character = asStub<Character>({
    id: 'maya',
    voiceOnly: false,
    lookId: 'maya',
    looks: [],
    selectedSheetVersionId: null,
    standardClothing: 'yellow rain jacket',
    distinguishingFeatures: '',
    ...overrides,
  });
  // this sheet-only plan only reads the character list and team id
  const scopedDb = asStub<ScopedDb>({
    teamId: 'team',
    characters: { list: async () => [character] },
  });
  // sheet-only planning reads the id and model settings
  const sequence = asStub<Sequence>({
    id: 'sequence',
    imageModel: 'nano_banana_2',
    analysisModel: null,
  });
  return buildPlanReferences({
    scopedDb,
    sequence,
    userId: 'user',
    units,
  });
}

describe('plan reference talent-sheet reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSheet.mockImplementation(async () => ({
      characterDbId: 'maya',
      reuseTalentSheet: false,
      referenceImageUrl: 'https://example.com/talent.jpg',
      talentMetadata: { standardClothing: 'yellow rain jacket' },
      castTalentDescription: 'A matching actor',
    }));
  });
  it('reuses a matching talent sheet for a missing first sheet without charging generation', async () => {
    const result = await references();
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ reuseTalentSheet: true }),
    ]);
    expect(result?.cost.sheets).toBe(0);
    expect(estimateSheets).toHaveBeenCalledWith(
      expect.objectContaining({ characterSheets: 0 })
    );
  });
  it('regenerates an existing selected sheet even when talent still matches', async () => {
    const result = await references({
      selectedSheetVersionId: 'existing-sheet',
    });
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ reuseTalentSheet: false }),
    ]);
    expect(result?.cost.sheets).toBe(100);
    expect(estimateSheets).toHaveBeenCalledWith(
      expect.objectContaining({ characterSheets: 1 })
    );
  });
  it('builds one sheet per look a unit names, deciding reuse per look (#2015)', async () => {
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
      reuseTalentSheet: false,
      referenceImageUrl: 'https://example.com/talent.jpg',
      talentMetadata: { standardClothing: 'yellow rain jacket' },
      castTalentDescription: 'A matching actor',
    }));
    // minimal looks: only what dressing and the reuse check read
    const look = (id: string, clothing: string, isDefault: boolean) =>
      asStub<Character['looks'][number]>({
        id,
        name: id,
        isDefault,
        clothing,
        styling: null,
        sheetImageUrl: null,
        sheetStatus: 'pending',
        sheetInputHash: null,
        selectedSheetVersionId: null,
      });
    const result = await references(
      {
        looks: [
          look('maya', 'yellow rain jacket', true),
          look('gala', 'floor-length red silk gown', false),
          look('unused', 'pyjamas', false),
        ],
      },
      [
        { kind: 'sheet:character', id: 'maya' },
        { kind: 'sheet:character', id: 'gala' },
      ]
    );
    // The default look matches the talent's own clothes and copies its sheet;
    // the gown does not, so it is drawn. The look no unit names is skipped.
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ lookId: 'maya', reuseTalentSheet: true }),
      expect.objectContaining({ lookId: 'gala', reuseTalentSheet: false }),
    ]);
    expect(result?.cost.sheets).toBe(100);
  });
  it('never copies the talent sheet onto a look other than the default', async () => {
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
      reuseTalentSheet: false,
      referenceImageUrl: 'https://example.com/talent.jpg',
      talentMetadata: { standardClothing: 'yellow rain jacket' },
      castTalentDescription: 'A matching actor',
    }));
    const look = (id: string, isDefault: boolean) =>
      asStub<Character['looks'][number]>({
        id,
        name: id,
        isDefault,
        clothing: 'yellow rain jacket',
        styling: null,
        sheetImageUrl: null,
        sheetStatus: 'pending',
        sheetInputHash: null,
        selectedSheetVersionId: null,
      });
    const result = await references(
      { looks: [look('maya', true), look('gala', false)] },
      [
        { kind: 'sheet:character', id: 'maya' },
        { kind: 'sheet:character', id: 'gala' },
      ]
    );
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ lookId: 'maya', reuseTalentSheet: true }),
      expect.objectContaining({ lookId: 'gala', reuseTalentSheet: false }),
    ]);
  });
  it('excludes voice-only cast from sheet work and its cost', async () => {
    const result = await references({ voiceOnly: true });
    expect(result?.characterSheets).toEqual([]);
    expect(result?.cost.sheets).toBe(0);
    expect(buildSheet).not.toHaveBeenCalled();
  });
});
