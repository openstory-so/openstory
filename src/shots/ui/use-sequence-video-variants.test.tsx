import { describe, expect, it, vi } from 'vitest';

const useQueryMock = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (...args: unknown[]) => useQueryMock(...args),
  };
});

const { EDITOR_FALLBACK_POLL_MS, useSequenceVideoVariants } =
  await import('./use-shots');

describe('useSequenceVideoVariants query options (#1381)', () => {
  it('passes EDITOR_FALLBACK_POLL_MS to useQuery when fallback polling is configured', () => {
    useSequenceVideoVariants('seq-1', {
      refetchInterval: EDITOR_FALLBACK_POLL_MS,
    });

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['sequence-video-variants', 'seq-1'],
        refetchInterval: EDITOR_FALLBACK_POLL_MS,
      })
    );
  });
});
