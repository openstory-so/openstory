import { QueryClient } from '@tanstack/react-query';
import { generateId, isValidId } from '@/platform/id';
import { describe, expect, it } from 'vitest';
import {
  allocateSequenceIds,
  beginSequenceCreate,
  buildOptimisticSequence,
  failSequenceCreate,
  finishSequenceCreate,
} from './optimistic-sequence';
import { isPendingSequenceCreate } from './pending-sequence-create';
import type { Sequence } from '@/platform/server/db/schema';
import type { CreateSequenceInput } from '@/sequences/server/sequence.schemas';

const sequenceDetailKey = (id: string) => ['sequences', 'detail', id] as const;
const shotListKey = (id: string) => ['shots', 'list', id] as const;
const sceneListKey = (id: string) => ['scenes', 'list', id] as const;

const INPUT = {
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  script: 'INT. LAUNDROMAT - NIGHT. A courier waits.',
  styleId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  title: 'Firefly Courier',
  aspectRatio: '9:16' as const,
  analysisModels: ['openai/gpt-5.6-luna'],
  imageModels: ['nano_banana_2_lite'],
  videoModel: 'minimax_h3_max',
  videoModels: ['minimax_h3_max'],
  autoGenerateMotion: true,
  autoGenerateMusic: false,
  generateStartFrames: false,
  stopAt: 'music' as const,
} satisfies CreateSequenceInput;

describe('allocateSequenceIds', () => {
  it('mints one ULID per analysis model', () => {
    const ids = allocateSequenceIds({
      ...INPUT,
      analysisModels: ['openai/gpt-5.6-luna', 'anthropic/claude-fable-5.1'],
    });
    expect(ids).toHaveLength(2);
    expect(ids.every(isValidId)).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('keeps client-supplied ids when the count matches', () => {
    const a = generateId();
    const b = generateId();
    expect(
      allocateSequenceIds({
        ...INPUT,
        analysisModels: ['openai/gpt-5.6-luna', 'anthropic/claude-fable-5.1'],
        ids: [a, b],
      })
    ).toEqual([a, b]);
  });
});

describe('buildOptimisticSequence', () => {
  it('is processing so the destination shows the split, not an empty board', () => {
    const id = generateId();
    const sequence = buildOptimisticSequence(id, INPUT);
    expect(sequence.id).toBe(id);
    expect(sequence.status).toBe('processing');
    expect(sequence.script).toBe(INPUT.script);
    expect(sequence.generateStartFrames).toBe(false);
    expect(sequence.generationStopAt).toBe('music');
  });
});

describe('beginSequenceCreate', () => {
  it('seeds the destination cache and marks the id pending before any fetch', () => {
    const queryClient = new QueryClient();
    const { ids } = beginSequenceCreate(queryClient, INPUT);
    const [id] = ids;
    expect(id).toBeDefined();
    if (!id) throw new Error('expected an id');

    expect(isPendingSequenceCreate(id)).toBe(true);
    expect(queryClient.getQueryData(sequenceDetailKey(id))).toMatchObject({
      id,
      status: 'processing',
      script: INPUT.script,
    });
    expect(queryClient.getQueryData(shotListKey(id))).toEqual([]);
    expect(queryClient.getQueryData(sceneListKey(id))).toEqual([]);

    const seeded = queryClient.getQueryData<Sequence>(sequenceDetailKey(id));
    expect(seeded).toBeDefined();
    if (!seeded) throw new Error('expected a seeded sequence');
    finishSequenceCreate(queryClient, id, {
      ...seeded,
      title: 'Named from split',
    });
    expect(isPendingSequenceCreate(id)).toBe(false);
    expect(queryClient.getQueryData(sequenceDetailKey(id))).toMatchObject({
      title: 'Named from split',
    });
  });

  it('drops the seed and leaves pending on failure', () => {
    const queryClient = new QueryClient();
    const { ids } = beginSequenceCreate(queryClient, INPUT);
    const [id] = ids;
    expect(id).toBeDefined();
    if (!id) throw new Error('expected an id');

    failSequenceCreate(queryClient, id);
    expect(isPendingSequenceCreate(id)).toBe(false);
    expect(queryClient.getQueryData(sequenceDetailKey(id))).toBeUndefined();
    expect(queryClient.getQueryData(shotListKey(id))).toBeUndefined();
  });
});
