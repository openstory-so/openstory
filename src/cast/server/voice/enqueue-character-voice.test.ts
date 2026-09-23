import { describe, expect, it, vi } from 'vitest';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { enqueueCharacterVoiceDesign } from './enqueue-character-voice';

function character(
  overrides: Partial<CharacterWithSheet> = {}
): CharacterWithSheet {
  return {
    id: 'char-1',
    sequenceId: 'seq-1',
    talentId: null,
    characterId: 'maya',
    name: 'Maya',
    age: null,
    gender: null,
    ethnicity: null,
    physicalDescription: null,
    standardClothing: null,
    distinguishingFeatures: null,
    personality: null,
    movement: null,
    voiceOnly: false,
    isPerson: true,
    voiceId: 'voice-old',
    voiceDescription: 'Warm alto',
    voicePreviews: null,
    useVoice: true,
    selectedVoiceVersionId: 'ver-old',
    pendingPromoteVoiceVersionId: null,
    consistencyTag: 'maya',
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    sheetStatus: 'completed',
    sheetError: null,
    selectedSheetVersionId: null,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sheetImageUrl: null,
    sheetImagePath: null,
    sheetGeneratedAt: null,
    sheetInputHash: null,
    ...overrides,
  };
}

function makeScopedDb(overrides: {
  live?: { id: string; workflowRunId: string | null }[];
}) {
  const listLiveVoiceClaims = vi.fn(async () => overrides.live ?? []);
  const createPendingVoiceClaim = vi.fn(
    async (): Promise<{
      version: { id: string; workflowRunId: string | null };
      created: boolean;
    }> => ({
      version: { id: 'husk-1', workflowRunId: null },
      created: true,
    })
  );
  const markVoiceClaimTerminal = vi.fn(async () => ({}));
  const stampVoiceClaimWorkflowRunId = vi.fn(async () => ({}));
  const releaseCharacterVoice = vi.fn();
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub of the enqueue surface
  const scopedDb = {
    teamId: 'team-1',
    characters: {
      listLiveVoiceClaims,
      createPendingVoiceClaim,
      markVoiceClaimTerminal,
      stampVoiceClaimWorkflowRunId,
    },
  } as unknown as ScopedDb;
  return {
    scopedDb,
    listLiveVoiceClaims,
    createPendingVoiceClaim,
    markVoiceClaimTerminal,
    stampVoiceClaimWorkflowRunId,
    releaseCharacterVoice,
  };
}

describe('enqueueCharacterVoiceDesign', () => {
  it('does not release the current voice before triggering (#1715)', async () => {
    const { scopedDb, createPendingVoiceClaim } = makeScopedDb({});
    const trigger = vi.fn(async () => 'run-1');
    const result = await enqueueCharacterVoiceDesign({
      scopedDb,
      character: character(),
      userId: 'user-1',
      analysisModel: null,
      takes: 2,
      trigger,
    });
    expect(createPendingVoiceClaim).toHaveBeenCalledWith('char-1', 'user-1');
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        characterDbId: 'char-1',
        targetVersionId: 'husk-1',
      })
    );
    expect(result).toEqual({
      characterId: 'char-1',
      workflowRunId: 'run-1',
      alreadyInFlight: false,
      targetVersionId: 'husk-1',
    });
  });

  it('stamps the workflow run id after a successful trigger (#1715)', async () => {
    const { scopedDb, stampVoiceClaimWorkflowRunId } = makeScopedDb({});
    await enqueueCharacterVoiceDesign({
      scopedDb,
      character: character(),
      userId: 'user-1',
      analysisModel: null,
      takes: 2,
      trigger: async () => 'run-1',
    });
    expect(stampVoiceClaimWorkflowRunId).toHaveBeenCalledWith(
      'husk-1',
      'run-1'
    );
  });

  it('returns the live husk instead of starting a second design (#1715)', async () => {
    const { scopedDb, createPendingVoiceClaim } = makeScopedDb({
      live: [{ id: 'husk-live', workflowRunId: 'run-live' }],
    });
    const trigger = vi.fn(async () => 'run-2');
    const result = await enqueueCharacterVoiceDesign({
      scopedDb,
      character: character(),
      userId: 'user-1',
      analysisModel: null,
      takes: 2,
      trigger,
    });
    expect(createPendingVoiceClaim).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
    expect(result.alreadyInFlight).toBe(true);
    expect(result.targetVersionId).toBe('husk-live');
    expect(result.workflowRunId).toBe('run-live');
  });

  it('fails the husk when trigger throws (#1715)', async () => {
    const { scopedDb, markVoiceClaimTerminal, stampVoiceClaimWorkflowRunId } =
      makeScopedDb({});
    await expect(
      enqueueCharacterVoiceDesign({
        scopedDb,
        character: character(),
        userId: 'user-1',
        analysisModel: null,
        takes: 2,
        trigger: async () => {
          throw new Error('workflow binding missing');
        },
      })
    ).rejects.toThrow('workflow binding missing');
    expect(markVoiceClaimTerminal).toHaveBeenCalledWith(
      'husk-1',
      'failed',
      'workflow binding missing'
    );
    expect(stampVoiceClaimWorkflowRunId).not.toHaveBeenCalled();
  });

  it('fails a zombie husk and starts a new design (#1715)', async () => {
    const { scopedDb, createPendingVoiceClaim, markVoiceClaimTerminal } =
      makeScopedDb({
        live: [{ id: 'husk-zombie', workflowRunId: null }],
      });
    const trigger = vi.fn(async () => 'run-2');
    const result = await enqueueCharacterVoiceDesign({
      scopedDb,
      character: character(),
      userId: 'user-1',
      analysisModel: null,
      takes: 2,
      trigger,
    });
    expect(markVoiceClaimTerminal).toHaveBeenCalledWith(
      'husk-zombie',
      'failed',
      'Voice design never started'
    );
    expect(createPendingVoiceClaim).toHaveBeenCalledWith('char-1', 'user-1');
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({ targetVersionId: 'husk-1' })
    );
    expect(result.alreadyInFlight).toBe(false);
    expect(result.targetVersionId).toBe('husk-1');
    expect(result.workflowRunId).toBe('run-2');
  });

  it('maps a unique-constraint race to alreadyInFlight (#1715)', async () => {
    const {
      scopedDb,
      listLiveVoiceClaims,
      createPendingVoiceClaim,
      stampVoiceClaimWorkflowRunId,
    } = makeScopedDb({});
    listLiveVoiceClaims.mockResolvedValueOnce([]);
    createPendingVoiceClaim.mockResolvedValue({
      version: { id: 'husk-live', workflowRunId: 'run-live' },
      created: false,
    });
    const trigger = vi.fn(async () => 'run-2');
    const result = await enqueueCharacterVoiceDesign({
      scopedDb,
      character: character(),
      userId: 'user-1',
      analysisModel: null,
      takes: 2,
      trigger,
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(stampVoiceClaimWorkflowRunId).not.toHaveBeenCalled();
    expect(result.alreadyInFlight).toBe(true);
    expect(result.targetVersionId).toBe('husk-live');
    expect(result.workflowRunId).toBe('run-live');
  });

  it('fails a unique-race zombie and inserts a new husk (#1715)', async () => {
    const { scopedDb, createPendingVoiceClaim, markVoiceClaimTerminal } =
      makeScopedDb({});
    createPendingVoiceClaim
      .mockResolvedValueOnce({
        version: { id: 'husk-zombie', workflowRunId: null },
        created: false,
      })
      .mockResolvedValueOnce({
        version: { id: 'husk-2', workflowRunId: null },
        created: true,
      });
    const trigger = vi.fn(async () => 'run-2');
    const result = await enqueueCharacterVoiceDesign({
      scopedDb,
      character: character(),
      userId: 'user-1',
      analysisModel: null,
      takes: 2,
      trigger,
    });
    expect(markVoiceClaimTerminal).toHaveBeenCalledWith(
      'husk-zombie',
      'failed',
      'Voice design never started'
    );
    expect(createPendingVoiceClaim).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({ targetVersionId: 'husk-2' })
    );
    expect(result.alreadyInFlight).toBe(false);
    expect(result.targetVersionId).toBe('husk-2');
  });
});
