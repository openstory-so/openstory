/**
 * DialogueTakeWorkflow (#1802): a mic take lands through the shot's claim,
 * is billed only once it fits, and frees the claim on every failure — a
 * leaked claim shows the shot as updating forever.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { DialogueTakeWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

const mockRecord = vi.fn();
const mockCut = vi.fn();
const mockDeduct = vi.fn();

vi.doMock('@/motion/server/record-dialogue-take', () => ({
  recordDialogueTake: mockRecord,
}));
vi.doMock('@/motion/server/cut-audio-section', () => ({
  cutAudioSection: mockCut,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeduct,
}));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit: vi.fn(async () => undefined) }),
}));

const { DialogueTakeWorkflow } = await import('./dialogue-take-workflow');

class Probe extends DialogueTakeWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<DialogueTakeWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
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

const steps: string[] = [];
function makeStep(): WorkflowStep {
  return asStub<WorkflowStep>({
    do: vi.fn((name: string, fn: () => Promise<unknown>) => {
      steps.push(name);
      return fn();
    }),
  });
}

function makeScopedDb(claimId: string | null) {
  const claimSpeech = vi.fn(async () => (claimId ? { 'shot-1': claimId } : {}));
  const appendSpeech = vi.fn(
    async (_input: {
      adoptedAs: string;
      turns: unknown[];
      sections: {
        spokenLines: unknown;
        adopt: { claimId: string; audioClips: unknown[] };
      }[];
    }) => ({ promotedShotIds: ['shot-1'] })
  );
  const failClaims = vi.fn(async () => undefined);
  const scopedDb = asStub<WorkflowScopedDb>({
    shotDialogue: { claimSpeech, appendSpeech, failClaims },
    credentials: { resolveKey: vi.fn(async () => ({ key: 'el-key' })) },
  });
  return { scopedDb, claimSpeech, appendSpeech, failClaims };
}

const input: DialogueTakeWorkflowInput = {
  userId: 'user-1',
  teamId: 'team-1',
  sequenceId: 'seq-1',
  shotId: 'shot-1',
  reservationId: 'res-1',
  ownsReservation: true,
  takeStorageKey: 'team-1/seq-1/dialogue-takes/take.wav',
  line: { index: 1, voiceId: 'voice-b', character: 'B', text: 'Hi', tone: '' },
  sourceKey: 'key-1',
  dialogueVersionId: 'dv-1',
  base: {
    storageKey: 'speech.wav',
    fromSeconds: 0,
    toSeconds: 4,
    lineStartSeconds: 2,
    lineEndSeconds: 3,
    turns: [],
    spokenLines: [
      { index: 0, text: 'Hello' },
      { index: 1, text: 'Hey' },
    ],
  },
  minDurationSeconds: 2,
  maxDurationSeconds: 15,
};

const event = asStub<WorkflowEvent<DialogueTakeWorkflowInput>>({
  payload: input,
  instanceId: 'run-1',
});

const take = (durationSeconds: number) => ({
  speechId: 'speech-2',
  storageKey: 'speech-2.wav',
  url: '/r2/speech-2.wav',
  durationSeconds,
  turns: [
    {
      shotId: 'shot-1',
      index: 0,
      voiceId: 'voice-a',
      ttsModel: 'seed',
      startSeconds: 0,
      endSeconds: 1,
      heardShare: 0.4,
    },
    {
      shotId: 'shot-1',
      index: 1,
      voiceId: 'voice-b',
      ttsModel: 'sts',
      startSeconds: 1,
      endSeconds: 2,
    },
  ],
  charges: [{ endpointId: 'sts', model: 'sts', costMicros: 100 }],
});

beforeEach(() => {
  steps.length = 0;
  mockRecord.mockReset();
  mockCut.mockReset();
  mockDeduct.mockReset();
  mockCut.mockResolvedValue({ url: '/r2/cut.wav', durationSeconds: 3 });
});

describe('DialogueTakeWorkflow', () => {
  it('lands a mic reading: billed after the fit check, other lines keep their doubt', async () => {
    mockRecord.mockResolvedValue(take(3));
    const db = makeScopedDb('claim-1');
    const result = await makeWorkflow().runBody(event, makeStep(), db.scopedDb);

    expect(result).toEqual({ promoted: true });
    expect(steps).toEqual(['claim', 'record-take', 'charge', 'cut', 'persist']);
    expect(mockDeduct).toHaveBeenCalledOnce();
    expect(mockDeduct.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: 'run-1:dialogue-take:sts',
      reservationId: 'res-1',
    });
    const appended = db.appendSpeech.mock.calls[0]?.[0];
    expect(appended).toMatchObject({ adoptedAs: 'mic', turns: take(3).turns });
    const section = appended?.sections[0];
    if (!section) throw new Error('no section appended');
    expect(section.adopt.claimId).toBe('claim-1');
    expect(section.spokenLines).toEqual([{ index: 0, text: 'Hello' }]);
    expect(section.adopt.audioClips[0]).toMatchObject({
      source: 'mic',
      unclearLines: [{ index: 0, heardShare: 0.4 }],
    });
    expect(db.failClaims).not.toHaveBeenCalled();
  });

  it('fails visibly with no claim, and spends nothing', async () => {
    const db = makeScopedDb(null);
    await expect(
      makeWorkflow().runBody(event, makeStep(), db.scopedDb)
    ).rejects.toThrow('already being recorded');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('refuses a take too long to fit without billing it, and frees the claim', async () => {
    mockRecord.mockResolvedValue(take(30));
    const db = makeScopedDb('claim-1');
    await expect(
      makeWorkflow().runBody(event, makeStep(), db.scopedDb)
    ).rejects.toThrow('has to fit');
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(db.appendSpeech).not.toHaveBeenCalled();
    expect(db.failClaims).toHaveBeenCalledWith(
      ['claim-1'],
      expect.stringContaining('has to fit')
    );
  });

  it('frees the claim when the recording fails', async () => {
    mockRecord.mockRejectedValue(new Error('Voice Changer 500'));
    const db = makeScopedDb('claim-1');
    await expect(
      makeWorkflow().runBody(event, makeStep(), db.scopedDb)
    ).rejects.toThrow('Voice Changer 500');
    expect(db.failClaims).toHaveBeenCalledWith(
      ['claim-1'],
      'Voice Changer 500'
    );
  });
});
