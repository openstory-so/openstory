import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';

const copyFile = vi.fn(async () => undefined);
const triggerWorkflow = vi.fn(async () => 'run-1');
vi.doMock('#storage', () => ({ copyFile }));
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));

const { copySequenceElements } = await import('./copy-sequence-elements');

function fakeDb(source: Record<string, unknown>) {
  const create = vi.fn(async (row: Record<string, unknown>) => row);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- copy only reaches sequenceElements.list/create
  const scopedDb = {
    sequenceElements: { list: vi.fn(async () => [source]), create },
  } as unknown as ScopedDb;
  return { scopedDb, create };
}

describe('copySequenceElements', () => {
  // #1559: the copy dropped both, so a duplicated clip landed as an IMAGE
  // (the column default) with no length — sent to image endpoints, and
  // waved past every length check on the video side.
  it('carries a clip’s kind and length', async () => {
    const { scopedDb, create } = fakeDb({
      token: 'SMOKE_INK',
      uploadedFilename: 'smoke-ink.mp4',
      imagePath: 'elements/team-1/seq-a/el-1.mp4',
      kind: 'video',
      durationSeconds: 22.5,
      visionStatus: 'pending',
      description: null,
      consistencyTag: null,
      visionGeneratedAt: null,
    });

    await copySequenceElements({
      scopedDb,
      teamId: 'team-1',
      userId: 'user-1',
      sourceSequenceId: 'seq-a',
      targetSequenceId: 'seq-b',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', durationSeconds: 22.5 })
    );
    // Vision reads pixels; a clip has none, so no vision run even though the
    // source never finished one.
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });
});
