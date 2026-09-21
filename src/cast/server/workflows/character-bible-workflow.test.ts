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
  const env = {
    CHARACTER_SHEET_WORKFLOW: {},
    CHARACTER_VOICE_WORKFLOW: {},
  } as unknown as Ctor[1];
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
const createPendingVoiceClaim = vi.fn(
  async (): Promise<{
    version: { id: string; workflowRunId: string | null };
    created: boolean;
  }> => ({
    version: { id: 'husk-1', workflowRunId: null },
    created: true,
  })
);
const markVoiceClaimTerminal = vi.fn(async () => ({ id: 'husk-1' }));

function makeScopedDb(): WorkflowScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return {
    characters: {
      create: characterCreate,
      createPendingVoiceClaim,
      markVoiceClaimTerminal,
    },
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
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
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
  isPerson: true,
});

function makeEvent(
  characterBible: CharacterBibleEntry[] = [sam, narrator],
  opts: { generateVoices?: boolean; speakingCharacterIds?: string[] } = {}
): Readonly<WorkflowEvent<CharacterBibleWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      characterBible,
      generateVoices: opts.generateVoices ?? false,
      speakingCharacterIds: opts.speakingCharacterIds ?? [],
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
        isPerson: true,
        sheetStatus: 'generating',
      }),
      expect.objectContaining({
        characterId: 'narrator',
        voiceOnly: true,
        isPerson: true,
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

  it('stamps voice generating before spawning the voice child (#1715)', async () => {
    mockSpawnAndAwaitChild.mockImplementation(
      async (_step: unknown, opts: { childId: string }) =>
        opts.childId.startsWith('character-voice:')
          ? { voiceId: 'voice-1', voiceDescription: 'Warm alto' }
          : {
              sheetImageUrl: '/r2/characters/sam.png',
              sheetVersionId: 'ver-sam',
            }
    );
    await makeWorkflow().runBody(
      makeEvent([sam], { generateVoices: true, speakingCharacterIds: ['sam'] }),
      makeStep(),
      makeScopedDb()
    );
    expect(createPendingVoiceClaim).toHaveBeenCalledWith(
      expect.any(String),
      'u1'
    );
    expect(mockSpawnAndAwaitChild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        childId: expect.stringMatching(/^character-voice:/),
        childPayload: expect.objectContaining({ targetVersionId: 'husk-1' }),
      })
    );
  });

  it('fails the husk if the voice child never starts (#1715)', async () => {
    mockSpawnAndAwaitChild.mockImplementation(
      async (_step: unknown, opts: { childId: string }) => {
        if (opts.childId.startsWith('character-voice:')) {
          throw new Error('workflow binding missing');
        }
        return {
          sheetImageUrl: '/r2/characters/sam.png',
          sheetVersionId: 'ver-sam',
        };
      }
    );
    await makeWorkflow().runBody(
      makeEvent([sam], { generateVoices: true, speakingCharacterIds: ['sam'] }),
      makeStep(),
      makeScopedDb()
    );
    expect(markVoiceClaimTerminal).toHaveBeenCalledWith(
      'husk-1',
      'failed',
      'workflow binding missing'
    );
  });

  it('skips spawn when a live husk already has a run id (#1715)', async () => {
    createPendingVoiceClaim.mockResolvedValueOnce({
      version: { id: 'husk-live', workflowRunId: 'run-live' },
      created: false,
    });
    mockSpawnAndAwaitChild.mockImplementation(
      async (_step: unknown, opts: { childId: string }) =>
        opts.childId.startsWith('character-voice:')
          ? { voiceId: 'voice-1', voiceDescription: 'Warm alto' }
          : {
              sheetImageUrl: '/r2/characters/sam.png',
              sheetVersionId: 'ver-sam',
            }
    );
    await makeWorkflow().runBody(
      makeEvent([sam], { generateVoices: true, speakingCharacterIds: ['sam'] }),
      makeStep(),
      makeScopedDb()
    );
    expect(mockSpawnAndAwaitChild).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        childId: expect.stringMatching(/^character-voice:/),
      })
    );
    expect(markVoiceClaimTerminal).not.toHaveBeenCalled();
  });

  it('adopts a zombie husk and fails it if spawn never starts (#1715)', async () => {
    createPendingVoiceClaim.mockResolvedValueOnce({
      version: { id: 'husk-zombie', workflowRunId: null },
      created: false,
    });
    mockSpawnAndAwaitChild.mockImplementation(
      async (_step: unknown, opts: { childId: string }) => {
        if (opts.childId.startsWith('character-voice:')) {
          throw new Error('workflow binding missing');
        }
        return {
          sheetImageUrl: '/r2/characters/sam.png',
          sheetVersionId: 'ver-sam',
        };
      }
    );
    await makeWorkflow().runBody(
      makeEvent([sam], { generateVoices: true, speakingCharacterIds: ['sam'] }),
      makeStep(),
      makeScopedDb()
    );
    expect(mockSpawnAndAwaitChild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        childPayload: expect.objectContaining({
          targetVersionId: 'husk-zombie',
        }),
      })
    );
    expect(markVoiceClaimTerminal).toHaveBeenCalledWith(
      'husk-zombie',
      'failed',
      'workflow binding missing'
    );
  });
});
