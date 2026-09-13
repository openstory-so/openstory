/**
 * A voice-only character (#1585) has no face to cast: the matcher never sees
 * it, and a match naming it anyway is dropped.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { TalentMatchingWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockDurableLLMCallCf = vi.fn();
const mockEmit = vi.fn();

vi.doMock('@/models/server/llm-call-helper', () => ({
  durableLLMCallCf: mockDurableLLMCallCf,
}));
vi.doMock('./wait-for-sheets', () => ({
  waitForTalentSheets: vi.fn(async () => ({
    ready: true,
    pendingIds: [],
    rows: [
      {
        id: 'tal-1',
        name: 'Ada',
        description: 'A ranch hand',
        personality: '',
        movement: '',
        defaultSheet: { imageUrl: '/r2/talent/ada.png', metadata: null },
      },
    ],
  })),
}));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit: mockEmit }),
}));

const { TalentMatchingWorkflow } = await import('./talent-matching-workflow');

class Probe extends TalentMatchingWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<TalentMatchingWorkflowInput>>,
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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

const entry = (
  overrides: Partial<CharacterBibleEntry> & { characterId: string }
): CharacterBibleEntry => ({
  name: overrides.characterId,
  age: '',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: '',
  distinguishingFeatures: '',
  personality: '',
  movement: '',
  voiceOnly: false,
  consistencyTag: overrides.characterId,
  ...overrides,
});

function makeEvent(): Readonly<WorkflowEvent<TalentMatchingWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      analysisModelId: 'anthropic/claude-opus-5',
      suggestedTalentIds: ['tal-1'],
      characterBible: [
        entry({ characterId: 'sam', name: 'Sam', physicalDescription: 'wiry' }),
        entry({ characterId: 'narrator', name: 'Narrator', voiceOnly: true }),
      ],
    },
    instanceId: 'run-1',
    workflowName: 'talent-matching',
    timestamp: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
});

describe('TalentMatchingWorkflow voice-only characters', () => {
  it('keeps them out of the prompt and drops a match that names one', async () => {
    // The model ignores the candidate list and casts the narrator anyway.
    mockDurableLLMCallCf.mockResolvedValue({
      matches: [{ characterId: 'narrator', talentId: 'tal-1' }],
    });

    const result = await makeWorkflow().runBody(
      makeEvent(),
      makeStep(),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- liveRead is consumed by the mocked wait only
      { liveRead: {} } as unknown as WorkflowScopedDb
    );

    expect(mockDurableLLMCallCf.mock.calls[0]?.[1]).toMatchObject({
      promptVariables: {
        charactersDescription: expect.stringContaining('Sam'),
        numCharacters: '1',
      },
    });
    expect(mockDurableLLMCallCf.mock.calls[0]?.[1]).not.toMatchObject({
      promptVariables: {
        charactersDescription: expect.stringContaining('Narrator'),
      },
    });

    expect(result.matches).toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
