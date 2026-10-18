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
  // The digest a pre-#2065 sheet carries: the same inputs, with the look's
  // stored parts beside them.
  computeCharacterSheetHashFromDtoBefore2065: async (
    payload: { snapshotInputHash: string },
    legacy: { distinguishingFeatures: string | null; styling: string | null }
  ) =>
    `old-${payload.snapshotInputHash}-${legacy.distinguishingFeatures}-${legacy.styling}`,
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

describe('plan reference character sheets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSheet.mockImplementation(async () => ({
      characterDbId: 'maya',
    }));
  });
  it('bills a missing first sheet', async () => {
    const result = await references();
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ characterDbId: 'maya' }),
    ]);
    expect(result?.cost.sheets).toBe(100);
    expect(estimateSheets).toHaveBeenCalledWith(
      expect.objectContaining({ characterSheets: 1 })
    );
  });
  it('bills an existing selected sheet the same way', async () => {
    const result = await references({
      selectedSheetVersionId: 'existing-sheet',
    });
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ characterDbId: 'maya' }),
    ]);
    expect(result?.cost.sheets).toBe(100);
    expect(estimateSheets).toHaveBeenCalledWith(
      expect.objectContaining({ characterSheets: 1 })
    );
  });
  it('builds one sheet per look a unit names (#2015)', async () => {
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
    }));
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
    // The gown waits for the default sheet this run makes. A look no unit
    // names is skipped. Both owed sheets are billed.
    expect(result?.characterSheets).toEqual([
      expect.objectContaining({ lookId: 'maya' }),
    ]);
    expect(result?.lookSheetsAfterDefault).toEqual([
      expect.objectContaining({ lookId: 'gala' }),
    ]);
    expect(buildSheet).toHaveBeenCalledTimes(1);
    expect(result?.cost.sheets).toBe(200);
  });
  it('drafts a non-default look to follow the default sheet', async () => {
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
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
      expect.objectContaining({ lookId: 'maya' }),
    ]);
    expect(result?.lookSheetsAfterDefault).toEqual([
      expect.objectContaining({ lookId: 'gala' }),
    ]);
  });
  it('draws a look now, from the live default sheet, when this run does not make the default', async () => {
    buildSheet.mockImplementation(async ({ lookId }: { lookId: string }) => ({
      characterDbId: 'maya',
      lookId,
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
