import { describe, expect, it, vi } from 'vitest';
import * as tanstackAi from '@tanstack/ai';

const mockStatus = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  getVideoJobStatus: mockStatus,
}));

const { getVideoJobStatus } = await import('./video-job-status');
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the wrapper only forwards args; the adapter is mocked away
const ARGS = { adapter: {}, jobId: 'job' } as never;
const call = () => getVideoJobStatus(ARGS);

describe('getVideoJobStatus', () => {
  it('rethrows a swallowed result-fetch failure so the poll step retries', async () => {
    mockStatus.mockResolvedValueOnce({
      jobId: 'job',
      status: 'failed',
      error: 'Failed to retrieve video result: HTTP 504: Gateway Timeout',
    });
    await expect(call()).rejects.toThrow('HTTP 504');
  });

  it('passes a real provider failure through', async () => {
    const failed = {
      jobId: 'job',
      status: 'failed',
      error:
        'Video generation failed: body.prompt: Request blocked due to safety violations (harmful content).',
    };
    mockStatus.mockResolvedValueOnce(failed);
    await expect(call()).resolves.toEqual(failed);
  });
});
