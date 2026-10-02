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

async function references(overrides: Partial<Character> = {}) {
  // only these character fields are consumed; payload construction is mocked
  const character = asStub<Character>({
    id: 'maya',
    voiceOnly: false,
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
    units: [{ kind: 'sheet:character', id: 'maya' }],
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
  it('excludes voice-only cast from sheet work and its cost', async () => {
    const result = await references({ voiceOnly: true });
    expect(result?.characterSheets).toEqual([]);
    expect(result?.cost.sheets).toBe(0);
    expect(buildSheet).not.toHaveBeenCalled();
  });
});
