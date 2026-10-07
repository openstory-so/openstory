import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Character, Sequence } from '@/platform/server/db/schema';
import { buildPlanReferences } from './update-stale-references';
import { asStub } from '@/test/as-stub';

const { buildSheet, buildDraft, estimateSheets, findReusable } = vi.hoisted(
  () => ({
    buildSheet: vi.fn(),
    // No finished sheet elsewhere unless a test says so (#2017).
    findReusable: vi.fn(
      async (_args: {
        lookId: string;
        model: string;
        inputHash: string;
      }): Promise<{ id: string; url: string; storagePath: string } | null> =>
        null
    ),
    buildDraft: vi.fn(async ({ lookId }: { lookId: string }) => ({
      draft: { characterDbId: 'maya', lookId },
      isDefault: false,
      liveFace: null,
      refusal: 'Drawn from the default look. Generate that sheet first.',
    })),
    estimateSheets: vi.fn(
      ({ characterSheets }: { characterSheets: number }) =>
        characterSheets * 100
    ),
  })
);
vi.mock('@/cast/server/sheets/character-sheet-trigger', () => ({
  buildRegenerateCharacterSheetPayload: buildSheet,
  buildCharacterSheetDraft: buildDraft,
}));
vi.mock('@/cast/server/workflows/sheet-snapshots', () => ({
  // The face joins the hash: a finished draft hashes differently per face.
  finishCharacterSheetPayload: async (
    draft: { lookId: string },
    face: { versionId: string } | null
  ) => ({
    ...draft,
    face,
    snapshotInputHash: `hash-${draft.lookId}-${face?.versionId ?? 'none'}`,
  }),
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
    characterSheetVariants: { findReusable },
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
    // The default look matches the talent's own clothes and copies its sheet.
    // The gown is drawn from that sheet, so it waits for it in the same run
    // (a draft with no face), and is billed. The look no unit names is
    // skipped.
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ lookId: 'maya', reuseTalentSheet: true }),
    ]);
    expect(result?.lookSheetsAfterDefault).toEqual([
      expect.objectContaining({ lookId: 'gala' }),
    ]);
    expect(buildSheet).toHaveBeenCalledTimes(1);
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
    ]);
    expect(result?.lookSheetsAfterDefault).toEqual([
      expect.objectContaining({ lookId: 'gala' }),
    ]);
  });
  it('draws a look now, from the live default sheet, when this run does not make the default', async () => {
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
      reuseTalentSheet: false,
      face: { url: '/r2/maya.png', versionId: 'maya-v1' },
    }));
    const look = (id: string, isDefault: boolean) =>
      asStub<Character['looks'][number]>({
        id,
        name: id,
        isDefault,
        clothing: 'gown',
        styling: null,
        sheetImageUrl: isDefault ? '/r2/maya.png' : null,
        sheetStatus: 'completed',
        sheetInputHash: null,
        selectedSheetVersionId: isDefault ? 'maya-v1' : null,
      });
    const result = await references(
      { looks: [look('maya', true), look('gala', false)] },
      [{ kind: 'sheet:character', id: 'gala' }]
    );
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({
        lookId: 'gala',
        reuseTalentSheet: false,
        face: { url: '/r2/maya.png', versionId: 'maya-v1' },
      }),
    ]);
    expect(result?.lookSheetsAfterDefault).toEqual([]);
    expect(buildDraft).not.toHaveBeenCalled();
  });
  it('excludes voice-only cast from sheet work and its cost', async () => {
    const result = await references({ voiceOnly: true });
    expect(result?.characterSheets).toEqual([]);
    expect(result?.cost.sheets).toBe(0);
    expect(buildSheet).not.toHaveBeenCalled();
  });
});

describe('plan reference sheet reuse by hash (#2017)', () => {
  const finished = (id: string) => ({
    id,
    url: `/r2/${id}.png`,
    storagePath: `${id}.png`,
  });
  // minimal looks: only what dressing and the reuse check read
  const look = (id: string, isDefault: boolean) =>
    asStub<Character['looks'][number]>({
      id,
      name: id,
      isDefault,
      clothing: isDefault ? 'yellow rain jacket' : 'gown',
      styling: null,
      sheetImageUrl: null,
      sheetStatus: 'pending',
      sheetInputHash: null,
      selectedSheetVersionId: null,
    });
  beforeEach(() => {
    vi.clearAllMocks();
    findReusable.mockImplementation(async () => null);
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
      imageModel: 'nano_banana_2',
      snapshotInputHash: `hash-${lookId}`,
      reuseTalentSheet: false,
      referenceImageUrl: 'https://example.com/talent.jpg',
      talentMetadata: { standardClothing: 'yellow rain jacket' },
      castTalentDescription: 'A matching actor',
    }));
  });
  it('points at a finished sheet of the same look, model and hash instead of drawing, at no cost', async () => {
    findReusable.mockResolvedValueOnce(finished('ep1-maya'));
    const result = await references();
    expect(findReusable).toHaveBeenCalledWith({
      lookId: 'maya',
      model: 'nano_banana_2',
      inputHash: 'hash-maya',
    });
    expect(result?.characterSheets).toEqual([]);
    expect(result?.reusedSheets).toEqual([
      {
        payload: expect.objectContaining({ lookId: 'maya' }),
        sheetVersionId: 'ep1-maya',
        url: '/r2/ep1-maya.png',
        storagePath: 'ep1-maya.png',
      },
    ]);
    expect(result?.cost.sheets).toBe(0);
    expect(estimateSheets).toHaveBeenCalledWith(
      expect.objectContaining({ characterSheets: 0 })
    );
  });
  it('wins over the talent copy: the look has its own sheet in this style', async () => {
    findReusable.mockResolvedValueOnce(finished('ep1-maya'));
    const result = await references();
    expect(result?.reusedSheets).toHaveLength(1);
    expect(result?.characterSheets).toEqual([]);
  });
  it('draws and prices the sheet when nothing matches', async () => {
    const result = await references({ selectedSheetVersionId: 'stale' });
    expect(result?.reusedSheets).toEqual([]);
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ lookId: 'maya' }),
    ]);
    expect(result?.cost.sheets).toBe(100);
  });
  it('gives a look whose default is reused that face now, and checks it for reuse too', async () => {
    findReusable.mockImplementation(async ({ lookId, inputHash }) => {
      if (lookId === 'maya') return finished('ep1-maya');
      // The gown drawn in episode 1 from that same face.
      if (lookId === 'gala' && inputHash === 'hash-gala-ep1-maya')
        return finished('ep1-gala');
      return null;
    });
    const result = await references(
      { looks: [look('maya', true), look('gala', false)] },
      [
        { kind: 'sheet:character', id: 'maya' },
        { kind: 'sheet:character', id: 'gala' },
      ]
    );
    expect(result?.reusedSheets.map((r) => r.sheetVersionId).sort()).toEqual([
      'ep1-gala',
      'ep1-maya',
    ]);
    expect(
      result?.reusedSheets.find((r) => r.payload.lookId === 'gala')?.payload
    ).toMatchObject({
      face: { url: '/r2/ep1-maya.png', versionId: 'ep1-maya' },
    });
    expect(result?.characterSheets).toEqual([]);
    expect(result?.lookSheetsAfterDefault).toEqual([]);
    expect(result?.cost.sheets).toBe(0);
  });
  it('draws a look now from the reused default when the look itself has no match', async () => {
    findReusable.mockImplementation(async ({ lookId }) =>
      lookId === 'maya' ? finished('ep1-maya') : null
    );
    const result = await references(
      { looks: [look('maya', true), look('gala', false)] },
      [
        { kind: 'sheet:character', id: 'maya' },
        { kind: 'sheet:character', id: 'gala' },
      ]
    );
    expect(result?.reusedSheets.map((r) => r.sheetVersionId)).toEqual([
      'ep1-maya',
    ]);
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({
        lookId: 'gala',
        face: { url: '/r2/ep1-maya.png', versionId: 'ep1-maya' },
      }),
    ]);
    expect(result?.lookSheetsAfterDefault).toEqual([]);
    expect(result?.cost.sheets).toBe(100);
  });
  it('still waits for a default this run draws', async () => {
    const result = await references(
      { looks: [look('maya', true), look('gala', false)] },
      [
        { kind: 'sheet:character', id: 'maya' },
        { kind: 'sheet:character', id: 'gala' },
      ]
    );
    expect(result?.reusedSheets).toEqual([]);
    expect(result?.lookSheetsAfterDefault).toEqual([
      expect.objectContaining({ lookId: 'gala' }),
    ]);
  });
});
