/**
 * A voice-only character (#1585) gets a row but never a sheet child: nothing
 * to draw, nothing to bill, nothing for the References stage to wait on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type {
  CharacterBibleWorkflowInput,
  CharacterSheetWorkflowInput,
} from '@/platform/server/workflow/types';
import type { NewCharacter } from '@/platform/server/db/schema';
import type { CharacterBibleDb } from './character-bible-workflow';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { CloudflareEnv } from '@/platform/server/workflow/types';
import {
  workflowBinding,
  workflowStep,
} from '@/platform/server/workflow/test-doubles';

const mockSpawnAndAwaitChild = vi.fn();

vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild: mockSpawnAndAwaitChild,
}));

const { CharacterBibleWorkflow } = await import('./character-bible-workflow');

class Probe extends CharacterBibleWorkflow<
  Pick<CloudflareEnv, 'CHARACTER_SHEET_WORKFLOW' | 'CHARACTER_VOICE_WORKFLOW'>
> {
  runBody(
    event: Readonly<WorkflowEvent<CharacterBibleWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: CharacterBibleDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  return new Probe(ctx, {
    CHARACTER_SHEET_WORKFLOW: workflowBinding(),
    CHARACTER_VOICE_WORKFLOW: workflowBinding(),
  });
}

function makeStep(): WorkflowStep {
  return workflowStep();
}

const characterCreate = vi.fn<CharacterBibleDb['characters']['create']>(
  async (row) => ({
    id: row.id ?? 'missing-id',
    characterId: row.characterId,
    selectedBibleVersionId: null,
    voiceId: row.voiceId ?? null,
    voiceDescription: row.voiceDescription ?? null,
    useVoice: null,
  })
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

function makeScopedDb(): CharacterBibleDb {
  return {
    characters: {
      create: characterCreate,
      claimSheet: async (id) => `ver-${id}`,
      createPendingVoiceClaim,
      markVoiceClaimTerminal,
    },
  };
}

function characterBibleSource(
  row: NewCharacter
): Parameters<
  typeof import('@/cast/server/bibles-from-scoped').characterToBible
>[0] {
  if (typeof row.voiceOnly !== 'boolean' || typeof row.isPerson !== 'boolean') {
    throw new Error('character insert is missing voiceOnly or isPerson');
  }
  return {
    characterId: row.characterId,
    name: row.name,
    age: row.age ?? null,
    gender: row.gender ?? null,
    ethnicity: row.ethnicity ?? null,
    physicalDescription: row.physicalDescription ?? null,
    standardClothing: row.standardClothing ?? null,
    distinguishingFeatures: row.distinguishingFeatures ?? null,
    personality: row.personality ?? null,
    movement: row.movement ?? null,
    voiceDescription: row.voiceDescription ?? null,
    voiceOnly: row.voiceOnly,
    isPerson: row.isPerson,
    consistencyTag: row.consistencyTag ?? null,
  };
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

  it('keeps the sequence at casting when a sheet fails with the narrator listed first (#1727)', async () => {
    mockSpawnAndAwaitChild.mockRejectedValueOnce(new Error('fal 500'));
    const result = await makeWorkflow().runBody(
      makeEvent([narrator, sam]),
      makeStep(),
      makeScopedDb()
    );

    expect(result).toEqual([
      expect.objectContaining({
        characterId: 'sam',
        name: 'Sam',
        sheetStatus: 'failed',
        sheetImageUrl: null,
        selectedSheetVersionId: null,
      }),
      expect.objectContaining({
        characterId: 'narrator',
        sheetStatus: 'completed',
        sheetImageUrl: null,
        selectedSheetVersionId: null,
      }),
    ]);
  });

  it('returns the sheets that landed when a sibling sheet fails (#1727)', async () => {
    const pat = entry({ characterId: 'pat', name: 'Pat' });
    mockSpawnAndAwaitChild.mockImplementation(async (_step, args) => {
      if (args.childPayload.characterName === 'Sam') {
        throw new Error('fal 500');
      }
      return {
        sheetImageUrl: '/r2/characters/pat.png',
        sheetVersionId: 'ver-pat',
      };
    });

    const result = await makeWorkflow().runBody(
      makeEvent([sam, pat]),
      makeStep(),
      makeScopedDb()
    );

    expect(result).toEqual([
      expect.objectContaining({
        characterId: 'sam',
        sheetStatus: 'failed',
        sheetImageUrl: null,
      }),
      expect.objectContaining({
        characterId: 'pat',
        sheetStatus: 'completed',
        sheetImageUrl: '/r2/characters/pat.png',
        selectedSheetVersionId: 'ver-pat',
      }),
    ]);
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

describe('CharacterBibleWorkflow pipeline sheets are tracked (#1113)', () => {
  it('claims each sheet and stamps the hash a regenerate of the row would compute', async () => {
    const { computeCharacterSheetHashFromDto } =
      await import('./sheet-snapshots');
    const { characterToBible } =
      await import('@/cast/server/bibles-from-scoped');

    await makeWorkflow().runBody(makeEvent([sam]), makeStep(), makeScopedDb());

    const [spawnCall] = mockSpawnAndAwaitChild.mock.calls;
    if (!spawnCall) throw new Error('expected a sheet child');
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the mocked spawn's second argument
    const { childPayload } = spawnCall[1] as {
      childPayload: CharacterSheetWorkflowInput;
    };
    const [row] = characterCreate.mock.calls[0] ?? [];
    if (!row) throw new Error('expected the character row');

    expect(childPayload.sheetVersionId).toBe(`ver-${row.id}`);
    expect(childPayload.snapshotInputHash).toBeDefined();

    // The staleness check hashes the stored row, not the LLM entry: a
    // pipeline sheet must not read "stale" the moment it lands.
    expect(
      await computeCharacterSheetHashFromDto({
        ...childPayload,
        characterMetadata: characterToBible(characterBibleSource(row)),
      })
    ).toBe(childPayload.snapshotInputHash);
  });
});
