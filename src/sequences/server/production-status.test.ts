import { describe, expect, test } from 'vitest';
import type { Sequence } from '@/platform/server/db/schema';
import { asStub } from '@/test/as-stub';
import type { ShotProductionReadiness } from './db/sequences';
import { buildProductionStatus } from './production-status';

const sequence = (overrides: Partial<Sequence>) =>
  asStub<Sequence>({
    id: 'seq_1',
    status: 'completed',
    statusError: null,
    includeMusic: false,
    musicStatus: 'pending',
    generateStartFrames: true,
    workflowRunId: null,
    ...overrides,
  });

const row = (overrides: Partial<ShotProductionReadiness> = {}) =>
  asStub<ShotProductionReadiness>({
    shotId: 'shot_1',
    selectedImageUrl: '/r2/still.png',
    imageStatus: 'completed',
    selectedVideoUrl: '/r2/clip.mp4',
    primaryVideoStatus: 'completed',
    primaryVideoId: 'vid_1',
    videoError: null,
    renderSegmentId: null,
    useStartFrame: null,
    ...overrides,
  });

const read = (rows: ShotProductionReadiness[]) => ({
  rows,
  exports: [],
  failedFrames: [],
});

describe('buildProductionStatus (#2104)', () => {
  const failed = sequence({
    status: 'failed',
    statusError:
      'Content checker rejected the generated dialogue (Seedance 2.5).',
  });

  test('a failure no live shot backs any more is not reported', () => {
    const status = buildProductionStatus(failed, read([row()]), true);

    expect(status.status).toBe('completed');
    expect(status.sequenceStatus).toBe('failed');
    expect(status.failures).toEqual([]);
  });

  test('a failure stays while a shot still lacks its clip', () => {
    const status = buildProductionStatus(
      failed,
      read([row(), row({ shotId: 'shot_2', selectedVideoUrl: null })]),
      true
    );

    expect(status.status).toBe('failed');
    expect(status.failures).toEqual([
      expect.objectContaining({ stage: 'sequence', id: 'seq_1' }),
    ]);
  });
});
