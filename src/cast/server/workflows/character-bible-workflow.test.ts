/**
 * A voice-only character (#1585) gets a row but never a sheet child: nothing
 * to draw, nothing to bill, nothing for the References stage to wait on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { CharacterBibleWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockSpawnAndAwaitChild = vi.fn();

vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild: mockSpawnAndAwaitChild,
}));

const { CharacterBibleWorkflow } = await import('./character-bible-workflow');

class Probe extends CharacterBibleWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<CharacterBibleWorkflowInput>>,
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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the binding is only handed to the (mocked) spawn
  const env = { CHARACTER_SHEET_WORKFLOW: {} } as unknown as Ctor[1];
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

const characterCreate = vi.fn(
  async (row: { id: string; characterId: string }) => row
);

function makeScopedDb(): WorkflowScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return {
    characters: { create: characterCreate },
  } as unknown as WorkflowScopedDb;
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

const sam = entry({
  characterId: 'sam',
  name: 'Sam',
  physicalDescription: 'wiry',
});
const narrator = entry({
  characterId: 'narrator',
  name: 'Narrator',
  personality: 'dry, unhurried, faintly amused',
  voiceOnly: true,
});

function makeEvent(
  characterBible: CharacterBibleEntry[] = [sam, narrator]
): Readonly<WorkflowEvent<CharacterBibleWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      characterBible,
      generateVoices: false,
      speakingCharacterIds: [],
      analysisModelId: 'anthropic/claude-sonnet-5',
    },
    instanceId: 'run-1',
    workflowName: 'character-bible',
    timestamp: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawnAndAwaitChild.mockResolvedValue({
    sheetImageUrl: '/r2/characters/sam.png',
    sheetVersionId: 'ver-sam',
  });
});

describe('CharacterBibleWorkflow voice-only characters', () => {
  it('creates the row completed with no sheet and spawns no child for it', async () => {
    const result = await makeWorkflow().runBody(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(characterCreate).toHaveBeenCalledTimes(2);
    expect(characterCreate.mock.calls.map(([row]) => row)).toEqual([
      expect.objectContaining({
        characterId: 'sam',
        voiceOnly: false,
        sheetStatus: 'generating',
      }),
      expect.objectContaining({
        characterId: 'narrator',
        voiceOnly: true,
        sheetStatus: 'completed',
      }),
    ]);

    expect(mockSpawnAndAwaitChild).toHaveBeenCalledTimes(1);
    expect(mockSpawnAndAwaitChild.mock.calls[0]?.[1]).toMatchObject({
      childPayload: { characterName: 'Sam' },
    });

    expect(result).toEqual([
      expect.objectContaining({
        characterId: 'sam',
        sheetImageUrl: '/r2/characters/sam.png',
        selectedSheetVersionId: 'ver-sam',
      }),
      expect.objectContaining({
        characterId: 'narrator',
        sheetStatus: 'completed',
        sheetImageUrl: null,
        selectedSheetVersionId: null,
      }),
    ]);
  });

  it('blames the right character when a sheet fails with the narrator listed first', async () => {
    mockSpawnAndAwaitChild.mockRejectedValueOnce(new Error('fal 500'));
    await expect(
      makeWorkflow().runBody(
        makeEvent([narrator, sam]),
        makeStep(),
        makeScopedDb()
      )
    ).rejects.toThrow(/Sam/);
  });
});
