/**
 * Money / slot-path test for CharacterVoiceWorkflow (#1553): one design call,
 * one deduction, one saved voice per run; the LLM drafts a description only
 * when the row has none; an empty design spends nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { CharacterVoiceWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { VOICE_DESIGN_COST } from '@/billing/elevenlabs-pricing';

const mockDesign = vi.fn();
const mockSave = vi.fn();
const mockDeduct = vi.fn();
const mockUpload = vi.fn();
const mockLlm = vi.fn();
const mockRecordProvenance = vi.fn();
const mockEmit = vi.fn();

vi.doMock('@/cast/server/voice/elevenlabs-voice', () => ({
  designVoicePreviews: mockDesign,
  saveDesignedVoice: mockSave,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeduct,
}));
vi.doMock('#storage', () => ({ uploadFile: mockUpload }));
vi.doMock('@/models/server/llm-call-helper', () => ({
  durableLLMCallCf: mockLlm,
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit: mockEmit }),
}));

const { CharacterVoiceWorkflow } = await import('./character-voice-workflow');

class Probe extends CharacterVoiceWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }

  failBody(
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>,
    error: string,
    scopedDb: WorkflowScopedDb
  ) {
    return this.onFailure({ event, error, scopedDb });
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; runImpl never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

function makeScopedDb(opts?: {
  pendingPromoteVoiceVersionId?: string | null;
  voiceId?: string | null;
  promote?: unknown;
}) {
  const completeVoiceClaimIfLive = vi.fn(async () => ({ id: 'ver-1' }));
  const promoteVoiceClaimIfPending = vi.fn(
    async () => opts?.promote ?? { id: 'char-1' }
  );
  const markVoiceClaimTerminal = vi.fn(async () => ({ id: 'ver-1' }));
  const markVoiceReleased = vi.fn(async () => undefined);
  const getById = vi.fn(async () => ({
    id: 'char-1',
    voiceId: opts?.voiceId ?? null,
    pendingPromoteVoiceVersionId:
      opts?.pendingPromoteVoiceVersionId === undefined
        ? 'ver-1'
        : opts.pendingPromoteVoiceVersionId,
  }));
  const getVoiceReferenceCount = vi.fn(async () => 1);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  const scopedDb = {
    characters: {
      completeVoiceClaimIfLive,
      promoteVoiceClaimIfPending,
      markVoiceClaimTerminal,
      markVoiceReleased,
    },
    liveRead: {
      characters: { getById, getVoiceReferenceCount },
    },
    provenance: {},
    credentials: { resolveKey: vi.fn(async () => ({ key: 'el-key' })) },
  } as unknown as WorkflowScopedDb;
  return {
    scopedDb,
    completeVoiceClaimIfLive,
    promoteVoiceClaimIfPending,
    markVoiceClaimTerminal,
  };
}

const characterBible: CharacterBibleEntry = {
  characterId: 'sam',
  name: 'Sam',
  age: '30s',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: 'duster',
  distinguishingFeatures: '',
  personality: '',
  movement: '',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  consistencyTag: 'sam',
};

function makeEvent(
  voiceDescription: string
): Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      characterDbId: 'char-1',
      characterBible,
      voiceDescription,
      analysisModelId: 'anthropic/claude-sonnet-5',
      targetVersionId: 'ver-1',
    },
    instanceId: 'run-1',
    workflowName: 'character-voice',
    timestamp: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDesign.mockResolvedValue([
    { generatedVoiceId: 'g1', audioBase64: 'AA==', mediaType: 'audio/mpeg' },
    { generatedVoiceId: 'g2', audioBase64: 'AA==', mediaType: 'audio/mpeg' },
  ]);
  mockSave.mockResolvedValue('voice-1');
  mockUpload.mockResolvedValue({ publicUrl: '/r2/a.mp3' });
  mockLlm.mockResolvedValue({ voiceDescription: 'Drafted gravel baritone.' });
});

describe('CharacterVoiceWorkflow', () => {
  it('designs once, deducts once, saves the top take, persists it', async () => {
    const { scopedDb, completeVoiceClaimIfLive, promoteVoiceClaimIfPending } =
      makeScopedDb();
    const result = await makeWorkflow().runBody(
      makeEvent('Warm alto, unhurried.'),
      makeStep(),
      scopedDb
    );

    expect(mockLlm).not.toHaveBeenCalled();
    expect(mockDesign).toHaveBeenCalledTimes(1);
    expect(mockDeduct).toHaveBeenCalledTimes(1);
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: VOICE_DESIGN_COST,
        idempotencyKey: 'run-1:voice-design',
      })
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(
      'el-key',
      expect.objectContaining({ generatedVoiceId: 'g1' })
    );
    expect(completeVoiceClaimIfLive).toHaveBeenCalledWith(
      'ver-1',
      expect.objectContaining({
        voiceId: 'voice-1',
        description: 'Warm alto, unhurried.',
        previews: [
          expect.objectContaining({
            generatedVoiceId: 'g1',
            takeNumber: 1,
            unusable: 'saved',
          }),
          expect.objectContaining({ generatedVoiceId: 'g2', takeNumber: 2 }),
        ],
      })
    );
    expect(promoteVoiceClaimIfPending).toHaveBeenCalledWith('char-1', 'ver-1');
    expect(result.voiceId).toBe('voice-1');
  });

  it('completes the husk without promoting when pending-promote was demoted (#1715)', async () => {
    const { scopedDb, completeVoiceClaimIfLive, promoteVoiceClaimIfPending } =
      makeScopedDb({ pendingPromoteVoiceVersionId: null });
    const result = await makeWorkflow().runBody(
      makeEvent('Warm alto, unhurried.'),
      makeStep(),
      scopedDb
    );
    expect(completeVoiceClaimIfLive).toHaveBeenCalledWith(
      'ver-1',
      expect.objectContaining({ voiceId: null })
    );
    expect(promoteVoiceClaimIfPending).not.toHaveBeenCalled();
    expect(result.voiceId).toBeNull();
  });

  it('marks the husk failed when the run dies (#1715)', async () => {
    const { scopedDb, markVoiceClaimTerminal } = makeScopedDb();
    await makeWorkflow().failBody(
      makeEvent('Warm alto, unhurried.'),
      'Voice Design returned no previews',
      scopedDb
    );
    expect(markVoiceClaimTerminal).toHaveBeenCalledWith(
      'ver-1',
      'failed',
      'Voice Design returned no previews'
    );
  });

  it('drafts a description from the bible when the row has none', async () => {
    const { scopedDb } = makeScopedDb();
    const result = await makeWorkflow().runBody(
      makeEvent('   '),
      makeStep(),
      scopedDb
    );
    expect(mockLlm).toHaveBeenCalledTimes(1);
    expect(mockDesign).toHaveBeenCalledWith(
      'el-key',
      'Drafted gravel baritone.'
    );
    expect(result.voiceDescription).toBe('Drafted gravel baritone.');
  });

  it('spends nothing when Voice Design returns no previews', async () => {
    mockDesign.mockResolvedValue([]);
    const { scopedDb, completeVoiceClaimIfLive } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent('x'), makeStep(), scopedDb)
    ).rejects.toThrow('no previews');
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(completeVoiceClaimIfLive).not.toHaveBeenCalled();
  });
});
