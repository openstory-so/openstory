/**
 * DialogueUploadWorkflow (#2264): a scene's recording lands on every speaking
 * shot through its claim, Scribe is billed once it has run, and every failure
 * frees the claims.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { DialogueUploadWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

const mockPlace = vi.fn();
const mockCut = vi.fn();
const mockDeduct = vi.fn();

vi.doMock('@/motion/server/place-uploaded-dialogue', () => ({
  placeUploadedDialogue: mockPlace,
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

const { DialogueUploadWorkflow } = await import('./dialogue-upload-workflow');

class Probe extends DialogueUploadWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<DialogueUploadWorkflowInput>>,
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

function makeScopedDb(claims: Record<string, string>) {
  const claimSpeech = vi.fn(async () => claims);
  const appendSpeech = vi.fn(
    async (_input: {
      adoptedAs: string;
      inputHash: string;
      sections: {
        shotId: string;
        adopt: { claimId: string; audioClips: { source?: string }[] };
      }[];
    }) => ({ promotedShotIds: ['shot-a', 'shot-b'] })
  );
  const failClaims = vi.fn(async () => undefined);
  const scopedDb = asStub<WorkflowScopedDb>({
    shotDialogue: { claimSpeech, appendSpeech, failClaims },
    credentials: { resolveKey: vi.fn(async () => ({ key: 'el-key' })) },
  });
  return { scopedDb, claimSpeech, appendSpeech, failClaims };
}

const line = (shotId: string, text: string) => ({
  shotId,
  index: 0,
  token: 'DIALOGUE',
  voiceId: `voice-${shotId}`,
  text,
  tone: '',
  ttsModel: 'eleven_v3',
  character: 'Mara',
});

const input: DialogueUploadWorkflowInput = {
  userId: 'user-1',
  organizationId: 'org-1',
  sequenceId: 'seq-1',
  reservationId: 'res-1',
  ownsReservation: true,
  storageKey: 'audio/teams/org-1/sequences/seq-1/dialogue-uploads/u.wav',
  voiced: [line('shot-a', 'Where were you'), line('shot-b', 'At the docks')],
  dialogueVersionIdByShotId: { 'shot-a': 'dv-a' },
  sceneShotNumberByShotId: { 'shot-a': 1, 'shot-b': 3 },
  minDurationSeconds: 2,
  maxDurationSeconds: 15,
};

const event = asStub<WorkflowEvent<DialogueUploadWorkflowInput>>({
  payload: input,
  instanceId: 'run-1',
});

const charges = [{ endpointId: 'scribe', model: 'scribe_v2', costMicros: 50 }];
const placed = (secondsB: number) => ({
  ok: true,
  speechId: 'speech-1',
  storageKey: 'speech-1.wav',
  url: '/r2/speech-1.wav',
  durationSeconds: 3 + secondsB,
  turns: [],
  windows: [
    { shotId: 'shot-a', fromSeconds: 0, toSeconds: 3 },
    { shotId: 'shot-b', fromSeconds: 3, toSeconds: 3 + secondsB },
  ],
  charges,
});
const bothClaimed = { 'shot-a': 'claim-a', 'shot-b': 'claim-b' };

beforeEach(() => {
  steps.length = 0;
  mockPlace.mockReset();
  mockCut.mockReset();
  mockDeduct.mockReset();
  mockCut.mockResolvedValue({ url: '/r2/cut.wav', durationSeconds: 3 });
});

describe('DialogueUploadWorkflow', () => {
  it('lands an upload section on every speaking shot under its claim', async () => {
    mockPlace.mockResolvedValue(placed(2));
    const db = makeScopedDb(bothClaimed);
    const result = await makeWorkflow().runBody(event, makeStep(), db.scopedDb);

    expect(result).toEqual({ promotedShotIds: ['shot-a', 'shot-b'] });
    expect(steps).toEqual([
      'claim',
      'place',
      'charge',
      'cut-shot-a',
      'cut-shot-b',
      'persist',
    ]);
    expect(mockDeduct.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: 'run-1:dialogue-upload:scribe',
      reservationId: 'res-1',
    });
    const appended = db.appendSpeech.mock.calls[0]?.[0];
    expect(appended).toMatchObject({
      adoptedAs: 'upload',
      inputHash: 'upload:speech-1',
    });
    expect(
      appended?.sections.map((section) => [
        section.shotId,
        section.adopt.claimId,
        section.adopt.audioClips[0]?.source,
      ])
    ).toEqual([
      ['shot-a', 'claim-a', 'upload'],
      ['shot-b', 'claim-b', 'upload'],
    ]);
    expect(db.failClaims).not.toHaveBeenCalled();
  });

  it('bills Scribe when a line is not found, then frees every claim', async () => {
    mockPlace.mockResolvedValue({
      ok: false,
      problem: 'Mara\'s line "At the docks" was not found in the recording',
      charges,
    });
    const db = makeScopedDb(bothClaimed);
    await expect(
      makeWorkflow().runBody(event, makeStep(), db.scopedDb)
    ).rejects.toThrow('"At the docks" was not found');
    expect(mockDeduct).toHaveBeenCalledOnce();
    expect(db.appendSpeech).not.toHaveBeenCalled();
    expect(db.failClaims).toHaveBeenCalledWith(
      ['claim-a', 'claim-b'],
      expect.stringContaining('not found')
    );
  });

  it('refuses a section too long to fit, naming the shot by its place in the scene', async () => {
    mockPlace.mockResolvedValue(placed(30));
    const db = makeScopedDb(bothClaimed);
    await expect(
      makeWorkflow().runBody(event, makeStep(), db.scopedDb)
    ).rejects.toThrow('shot 3 of the scene runs 30.0s');
    expect(db.appendSpeech).not.toHaveBeenCalled();
    expect(db.failClaims).toHaveBeenCalledOnce();
  });

  it('fails without spending when another run holds a shot', async () => {
    const db = makeScopedDb({ 'shot-a': 'claim-a' });
    await expect(
      makeWorkflow().runBody(event, makeStep(), db.scopedDb)
    ).rejects.toThrow('started recording its dialogue');
    expect(mockPlace).not.toHaveBeenCalled();
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(db.failClaims).toHaveBeenCalledWith(['claim-a'], expect.any(String));
  });
});
