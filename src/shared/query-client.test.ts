import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountRestrictedError, AuthenticationError } from './errors';
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
