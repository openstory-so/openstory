import {
  MutationObserver,
  QueryObserver,
  type QueryClient,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountRestrictedError, AuthenticationError } from '@/platform/errors';
import { makeQueryClient } from './query-client';

describe('MutationCache', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates matching queries when mutation has a mutationKey', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const observer = new MutationObserver(qc, {
      mutationKey: ['items', 'org-1'],
      mutationFn: () => Promise.resolve('ok'),
    });
    await observer.mutate();

    expect(spy).toHaveBeenCalledWith({
      queryKey: ['items', 'org-1'],
    });
  });

  it('invalidates ALL queries when mutation has no mutationKey', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const observer = new MutationObserver(qc, {
      mutationFn: () => Promise.resolve('ok'),
    });
    await observer.mutate();

    expect(spy).toHaveBeenCalledWith({
      queryKey: undefined,
    });
  });

  it('uses the correct key for each mutation', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const first = new MutationObserver(qc, {
      mutationKey: ['categories', 'org-1'],
      mutationFn: () => Promise.resolve('a'),
    });
    await first.mutate();

    const second = new MutationObserver(qc, {
      mutationKey: ['items', 'org-1'],
      mutationFn: () => Promise.resolve('b'),
    });
    await second.mutate();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, {
      queryKey: ['categories', 'org-1'],
    });
    expect(spy).toHaveBeenNthCalledWith(2, { queryKey: ['items', 'org-1'] });
  });
});

describe('query retry default', () => {
  const retryOf = (qc: QueryClient) => {
    const retry = qc.getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('retry must be a fn');
    return retry;
  };

  it('never retries a 401/403 (#1333)', () => {
    const retry = retryOf(makeQueryClient());
    expect(retry(0, new AuthenticationError('Authentication required'))).toBe(
      false
    );
    expect(retry(0, new AccountRestrictedError())).toBe(false);
  });

  it('keeps RQ default of 0 retries on the server for other errors', () => {
    const retry = retryOf(makeQueryClient());
    expect(retry(0, new Error('boom'))).toBe(false);
  });

  it('keeps RQ default of 3 retries in the browser for other errors', async () => {
    vi.stubGlobal('window', {});
    vi.resetModules();
    const { makeQueryClient: makeBrowserQueryClient } =
      await import('./query-client');
    vi.unstubAllGlobals();
    const retry = retryOf(makeBrowserQueryClient());
    expect(retry(0, new Error('boom'))).toBe(true);
    expect(retry(2, new Error('boom'))).toBe(true);
    expect(retry(3, new Error('boom'))).toBe(false);
  });
});

describe('rejected sessions (#1663)', () => {
  const session = { user: { id: 'user-1' } };

  it('disables session-gated reads after the first 401', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session'], session);
    const sessionObserver = new QueryObserver(qc, {
      queryKey: ['session'],
      enabled: false,
    });
    const read = vi.fn().mockRejectedValue(new AuthenticationError('Expired'));
    const options = {
      queryKey: ['billing-balance'],
      queryFn: read,
      enabled: !!qc.getQueryData(['session']),
    };
    const observer = new QueryObserver(qc, options);
    const unsubscribeSession = sessionObserver.subscribe((result) => {
      observer.setOptions({ ...options, enabled: !!result.data });
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().isError).toBe(true)
      );
      expect(qc.getQueryData(['session'])).toBeNull();
      await qc.invalidateQueries({ queryKey: ['billing-balance'] });
      expect(read).toHaveBeenCalledTimes(1);

      // A later successful sign-in can enable the same reads again.
      read.mockResolvedValue('balance');
      qc.setQueryData(['session'], session);
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toBe('balance')
      );
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      unsubscribeSession();
      qc.clear();
    }
  });

  it('clears a session on a mutation 401 even with a local error handler', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session'], session);
    const error = new AuthenticationError('Expired');
    const observer = new MutationObserver(qc, {
      mutationFn: () => Promise.reject(error),
      onError: vi.fn(),
    });
    await expect(observer.mutate(undefined)).rejects.toBe(error);
    expect(qc.getQueryData(['session'])).toBeNull();
    qc.clear();
  });

  it.each([new AccountRestrictedError(), new Error('Network failure')])(
    'preserves the session for %s',
    async (error) => {
      const qc = makeQueryClient();
      qc.setQueryData(['session'], session);
      await expect(
        qc.fetchQuery({
          queryKey: ['protected'],
          queryFn: () => Promise.reject(error),
        })
      ).rejects.toBe(error);
      expect(qc.getQueryData(['session'])).toEqual(session);
      qc.clear();
    }
  );

  it('prevents an older in-flight session read from restoring the rejected session', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session'], session);
    let resolveSession!: (value: typeof session) => void;
    const pending = qc
      .fetchQuery({
        queryKey: ['session'],
        staleTime: 0,
        queryFn: () =>
          new Promise<typeof session>((resolve) => {
            resolveSession = resolve;
          }),
      })
      .catch(() => null);
    const error = new AuthenticationError('Expired');
    await expect(
      qc.fetchQuery({
        queryKey: ['protected'],
        queryFn: () => Promise.reject(error),
      })
    ).rejects.toBe(error);
    resolveSession(session);
    await pending;
    expect(qc.getQueryData(['session'])).toBeNull();
    qc.clear();
  });
});
