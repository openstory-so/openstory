import { describe, expect, it, vi, beforeEach } from 'vitest';

const useQueryMock = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (...args: unknown[]) => useQueryMock(...args),
  };
});

const getSequenceVideoVariantsFn = vi.fn();
vi.doMock('@/shots/shots.fn', () => ({ getSequenceVideoVariantsFn }));

const { EDITOR_FALLBACK_POLL_MS, useSequenceVideoVariants } =
  await import('./use-shots');

beforeEach(() => {
  useQueryMock.mockClear();
  getSequenceVideoVariantsFn.mockClear();
});

describe('useSequenceVideoVariants query options (#1381)', () => {
  it('passes EDITOR_FALLBACK_POLL_MS to useQuery when fallback polling is configured', () => {
    useSequenceVideoVariants('seq-1', {
      refetchInterval: EDITOR_FALLBACK_POLL_MS,
    });

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['sequence-video-variants', 'seq-1'],
        refetchInterval: EDITOR_FALLBACK_POLL_MS,
        enabled: true,
        staleTime: 30_000,
      })
    );
  });

  it('defaults refetchInterval to false when options are undefined', () => {
    useSequenceVideoVariants('seq-1', undefined);

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['sequence-video-variants', 'seq-1'],
        refetchInterval: false,
        enabled: true,
        staleTime: 30_000,
      })
    );
  });

  it('defaults refetchInterval to false when options are omitted', () => {
    useSequenceVideoVariants('seq-2');

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['sequence-video-variants', 'seq-2'],
        refetchInterval: false,
        enabled: true,
        staleTime: 30_000,
      })
    );
  });

  it('disables the query when sequenceId is omitted', () => {
    useSequenceVideoVariants(undefined, {
      refetchInterval: EDITOR_FALLBACK_POLL_MS,
    });

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['sequence-video-variants', ''],
        enabled: false,
        refetchInterval: EDITOR_FALLBACK_POLL_MS,
      })
    );
  });

  it('calls getSequenceVideoVariantsFn when queryFn is executed', async () => {
    getSequenceVideoVariantsFn.mockResolvedValueOnce([{ id: 'v1' }]);
    useSequenceVideoVariants('seq-3');

    const passedOptions = useQueryMock.mock.calls[0]?.[0];
    expect(passedOptions).toBeDefined();

    const result = await passedOptions.queryFn();
    expect(getSequenceVideoVariantsFn).toHaveBeenCalledWith({
      data: { sequenceId: 'seq-3' },
    });
    expect(result).toEqual([{ id: 'v1' }]);
  });
});
