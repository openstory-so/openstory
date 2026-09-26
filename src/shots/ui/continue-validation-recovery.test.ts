import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { shotKeys } from './use-shots';
import { refreshAfterContinueValidationError } from './continue-validation-recovery';

describe('refreshAfterContinueValidationError', () => {
  it('replaces stale sequence, character, and shot data on validation errors', async () => {
    const queryClient = new QueryClient();
    const queries = [
      {
        queryKey: sequenceKeys.detail('sequence_1'),
        stale: 'stale sequence',
        fresh: 'fresh sequence',
        queryFn: vi.fn(async () => 'fresh sequence'),
      },
      {
        queryKey: sequenceCharacterKeys.list('sequence_1'),
        stale: 'stale characters',
        fresh: 'fresh characters',
        queryFn: vi.fn(async () => 'fresh characters'),
      },
      {
        queryKey: shotKeys.list('sequence_1'),
        stale: 'stale shots',
        fresh: 'fresh shots',
        queryFn: vi.fn(async () => 'fresh shots'),
      },
    ] as const;
    for (const query of queries) {
      queryClient.setQueryData(query.queryKey, query.stale);
    }
    const unsubscribe = queries.map((query) =>
      new QueryObserver(queryClient, {
        queryKey: query.queryKey,
        queryFn: query.queryFn,
        staleTime: Infinity,
      }).subscribe(() => {})
    );

    try {
      await refreshAfterContinueValidationError(
        queryClient,
        'sequence_1',
        Object.assign(new Error('Stale continue state'), {
          code: 'VALIDATION_ERROR',
        })
      );

      for (const query of queries) {
        expect(queryClient.getQueryData(query.queryKey)).toBe(query.fresh);
        expect(query.queryFn).toHaveBeenCalledTimes(1);
      }
    } finally {
      unsubscribe.forEach((stop) => stop());
    }
  });

  it('does not refresh unrelated continue failures', async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    await refreshAfterContinueValidationError(
      queryClient,
      'sequence_1',
      new Error('Request failed')
    );

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('waits for active refreshes without replacing the validation failure', async () => {
    const queryClient = new QueryClient();
    let resolveInvalidation!: () => void;
    const invalidation = new Promise<void>((resolve) => {
      resolveInvalidation = resolve;
    });
    const invalidateQueries = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockReturnValue(invalidation);

    const refresh = refreshAfterContinueValidationError(
      queryClient,
      'sequence_1',
      Object.assign(new Error('Stale continue state'), {
        code: 'VALIDATION_ERROR',
      })
    );
    let settled = false;
    void refresh.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(settled).toBe(false);

    resolveInvalidation();
    await refresh;
    expect(settled).toBe(true);
  });

  it('does not reject when a refreshed query fails', async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, 'invalidateQueries').mockRejectedValue(
      new Error('Refresh failed')
    );

    await expect(
      refreshAfterContinueValidationError(
        queryClient,
        'sequence_1',
        Object.assign(new Error('Stale continue state'), {
          code: 'VALIDATION_ERROR',
        })
      )
    ).resolves.toBeUndefined();
  });
});
