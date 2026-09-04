import { describe, expect, it, vi } from 'vitest';
import { exportSequenceOnServer } from './server-export-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('exportSequenceOnServer', () => {
  it('returns immediately when POST serves a ready hash-matched export', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        export: {
          id: 'exp-1',
          status: 'ready',
          url: 'https://cdn.example/cut.mp4',
          error: null,
        },
      })
    );
    await expect(
      exportSequenceOnServer({
        sequenceId: 'seq-1',
        signal: new AbortController().signal,
        fetchFn,
      })
    ).resolves.toEqual({ url: 'https://cdn.example/cut.mp4' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('polls GET until the processing row becomes ready', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          export: {
            id: 'exp-1',
            status: 'processing',
            url: null,
            error: null,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          exports: [
            {
              id: 'exp-1',
              status: 'processing',
              url: null,
              error: null,
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          exports: [
            {
              id: 'exp-1',
              status: 'ready',
              url: 'https://cdn.example/cut.mp4',
              error: null,
            },
          ],
        })
      );
    const sleepFn = vi.fn(async () => {});
    await expect(
      exportSequenceOnServer({
        sequenceId: 'seq-1',
        signal: new AbortController().signal,
        fetchFn,
        sleepFn,
      })
    ).resolves.toEqual({ url: 'https://cdn.example/cut.mp4' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain('wait=60s');
  });

  it('throws the container failure message when the row fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          export: {
            id: 'exp-1',
            status: 'processing',
            url: null,
            error: null,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          exports: [
            {
              id: 'exp-1',
              status: 'failed',
              url: null,
              error: 'Scenes have mixed resolutions (1920×1080, 1280×720)',
            },
          ],
        })
      );
    await expect(
      exportSequenceOnServer({
        sequenceId: 'seq-1',
        signal: new AbortController().signal,
        fetchFn,
        sleepFn: async () => {},
      })
    ).rejects.toThrow(/mixed resolutions/);
  });

  it('surfaces the API error envelope on a failed POST', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'No scene videos are ready yet',
        },
      })
    );
    await expect(
      exportSequenceOnServer({
        sequenceId: 'seq-1',
        signal: new AbortController().signal,
        fetchFn,
      })
    ).rejects.toThrow('No scene videos are ready yet');
  });
});
