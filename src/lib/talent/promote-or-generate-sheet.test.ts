import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/db/scoped';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import {
  libraryTalentGenerateDedupId,
  libraryTalentUploadDedupId,
} from './library-talent-sheet-dedup';

type TriggerOptions = { deduplicationId?: string };

const mockTriggerWorkflow =
  vi.fn<
    (
      path: string,
      payload: LibraryTalentSheetWorkflowInput,
      options?: TriggerOptions
    ) => Promise<string>
  >();
const mockAnalyze = vi.fn();
const mockEmit = vi.fn();

vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('@/lib/realtime', () => ({
  getTalentChannel: () => ({ emit: mockEmit }),
}));
vi.doMock('./analyze-talent-media', () => ({
  analyzeTalentMediaForTeam: mockAnalyze,
  sheetMetadataFromAnalysis: (name: string) => ({
    characterId: name.toLowerCase(),
    name,
    age: '',
    gender: '',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
    consistencyTag: name.toLowerCase(),
  }),
}));

const { maybePromoteOrGenerateSheet } =
  await import('./promote-or-generate-sheet');

const TEAM = 'team-1';
const TALENT_ID = 'tal-1';
const PHOTO_URL = '/r2/talent/team-1/tal-1/photo.png';
const SHEET_URL = '/r2/talent/team-1/tal-1/sheet.png';

function talentRow(opts: {
  sheets?: Array<{ divergedAt: Date | null }>;
  media?: Array<{ type: string; url: string }>;
}) {
  return {
    id: TALENT_ID,
    teamId: TEAM,
    isPublic: false,
    name: 'Sam',
    description: null,
    sheets: opts.sheets ?? [],
    media: opts.media ?? [{ type: 'image', url: PHOTO_URL }],
  };
}

function scopedDb(row: ReturnType<typeof talentRow>): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only getWithRelations
  return {
    talent: {
      getWithRelations: vi.fn(async () => row),
    },
  } as unknown as ScopedDb;
}

function lastTrigger() {
  const call = mockTriggerWorkflow.mock.calls[0];
  if (!call) throw new Error('expected triggerWorkflow to have been called');
  return { payload: call[1], options: call[2] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerWorkflow.mockResolvedValue('run-1');
  mockEmit.mockResolvedValue(undefined);
  mockAnalyze.mockResolvedValue({
    isCharacterSheet: false,
    subjectKind: 'human',
    suggestedName: '',
    description: '',
    age: '',
    gender: '',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
  });
});

describe('maybePromoteOrGenerateSheet', () => {
  it('does not trigger when a photo is added and a convergent sheet exists', async () => {
    await maybePromoteOrGenerateSheet({
      scopedDb: scopedDb(talentRow({ sheets: [{ divergedAt: null }] })),
      userId: 'u1',
      teamId: TEAM,
      talentId: TALENT_ID,
      imageUrl: PHOTO_URL,
    });
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('triggers generate-if-missing when there is no convergent sheet', async () => {
    await maybePromoteOrGenerateSheet({
      scopedDb: scopedDb(talentRow({ sheets: [] })),
      userId: 'u1',
      teamId: TEAM,
      talentId: TALENT_ID,
      imageUrl: PHOTO_URL,
    });
    expect(mockTriggerWorkflow).toHaveBeenCalledTimes(1);
    const { payload, options } = lastTrigger();
    expect(payload.uploadedSheetUrl).toBeUndefined();
    expect(payload.sheetName).toBe('Default Sheet');
    expect(options?.deduplicationId).toBe(
      libraryTalentGenerateDedupId(TALENT_ID)
    );
  });

  it('promotes an uploaded sheet even when a convergent sheet already exists', async () => {
    mockAnalyze.mockResolvedValueOnce({
      isCharacterSheet: true,
      subjectKind: 'human',
      suggestedName: '',
      description: '',
      age: '',
      gender: '',
      ethnicity: '',
      physicalDescription: '',
      standardClothing: '',
      distinguishingFeatures: '',
    });
    await maybePromoteOrGenerateSheet({
      scopedDb: scopedDb(
        talentRow({
          sheets: [{ divergedAt: null }],
          media: [{ type: 'image', url: SHEET_URL }],
        })
      ),
      userId: 'u1',
      teamId: TEAM,
      talentId: TALENT_ID,
      imageUrl: SHEET_URL,
    });
    const { payload, options } = lastTrigger();
    expect(payload.uploadedSheetUrl).toBe(SHEET_URL);
    expect(options?.deduplicationId).toBe(
      libraryTalentUploadDedupId(TALENT_ID, SHEET_URL)
    );
  });

  it('skips when vision throws and a convergent sheet exists', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('vision down'));
    await maybePromoteOrGenerateSheet({
      scopedDb: scopedDb(talentRow({ sheets: [{ divergedAt: null }] })),
      userId: 'u1',
      teamId: TEAM,
      talentId: TALENT_ID,
      imageUrl: PHOTO_URL,
    });
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('generates when vision throws and there is no convergent sheet', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('vision down'));
    await maybePromoteOrGenerateSheet({
      scopedDb: scopedDb(talentRow({ sheets: [] })),
      userId: 'u1',
      teamId: TEAM,
      talentId: TALENT_ID,
      imageUrl: PHOTO_URL,
    });
    expect(lastTrigger().payload.uploadedSheetUrl).toBeUndefined();
  });

  it('treats only-divergent sheets as missing', async () => {
    await maybePromoteOrGenerateSheet({
      scopedDb: scopedDb(talentRow({ sheets: [{ divergedAt: new Date() }] })),
      userId: 'u1',
      teamId: TEAM,
      talentId: TALENT_ID,
      imageUrl: PHOTO_URL,
    });
    expect(mockTriggerWorkflow).toHaveBeenCalled();
  });

  it('emits failed and throws when triggerWorkflow throws', async () => {
    mockTriggerWorkflow.mockRejectedValueOnce(new Error('no binding'));
    await expect(
      maybePromoteOrGenerateSheet({
        scopedDb: scopedDb(talentRow({ sheets: [] })),
        userId: 'u1',
        teamId: TEAM,
        talentId: TALENT_ID,
        imageUrl: PHOTO_URL,
      })
    ).rejects.toThrow('no binding');
    expect(mockEmit).toHaveBeenCalledWith(
      'talent.sheet:progress',
      expect.objectContaining({
        status: 'failed',
        error: 'no binding',
      })
    );
    expect(mockEmit).not.toHaveBeenCalledWith(
      'talent.sheet:progress',
      expect.objectContaining({ status: 'generating' })
    );
  });
});
