import type { ScopedDb } from '@/platform/server/db/scoped';
import { describe, expect, it, vi } from 'vitest';
import { createBlankSequence } from './create-blank-sequence';

vi.mock('@/platform/id', () => ({
  generateId: () => '01BLANKSEQUENCEULID000000',
}));

describe('createBlankSequence', () => {
  it('writes an empty draft and does not start a workflow', async () => {
    const create = vi.fn(async (row: { script: string }) => ({
      id: row,
      ...row,
    }));
    const createForSequence = vi.fn();
    const scopedDb = {
      styles: {
        getById: vi.fn(async () => ({
          id: 'style-1',
          sequenceId: null,
        })),
        createForSequence,
      },
      sequences: {
        getById: vi.fn(),
        create,
      },
    };

    await createBlankSequence(
      {
        styleId: 'style-1',
        aspectRatio: '16:9',
        resolution: '720p',
        analysisModel: 'anthropic/claude-sonnet-5.5',
        imageModel: 'nano_banana_2',
        videoModel: 'seedance_2_0',
      },
      {
        // Fake covers getById/create only.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        scopedDb: scopedDb as unknown as ScopedDb,
        user: { id: 'user-1' },
      }
    );

    expect(createForSequence).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        script: '',
        styleId: 'style-1',
        generationStopAt: 'script',
        title: expect.any(String),
      })
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('workflowRunId');
  });
});
