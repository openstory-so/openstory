import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const deleteShotFn = vi.fn();
vi.doMock('@/shots/shots.fn', () => ({ deleteShotFn }));
vi.doMock('@/shots/scenes.fn', () => ({}));
const { useSoftDeleteShot } = await import('./use-scene-structure');
const { shotKeys } = await import('./use-shots');

const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.resetAllMocks();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  let mutation: ReturnType<typeof useSoftDeleteShot> | undefined;
  function Probe() {
    // oxlint-disable-next-line react/globals -- hands mutateAsync from a one-shot SSR probe to the test; never used for rendering.
    mutation = useSoftDeleteShot('sequence-a');
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  if (!mutation) throw new Error('hook did not run');
  const key = shotKeys.list('sequence-a');
  client.setQueryData(key, [{ id: 'deleted' }, { id: 'kept' }]);
  client.setQueryData(shotKeys.list('sequence-b'), [{ id: 'deleted' }]);
  return { client, key, mutation };
}

const deleted = {
  success: true,
  sequenceId: 'sequence-a',
  deletedAt: new Date(),
};

describe('useSoftDeleteShot list cache', () => {
  it('removes only the deleted shot from its own sequence once the delete succeeds', async () => {
    deleteShotFn.mockResolvedValue(deleted);
    const { client, key, mutation } = setup();
    await mutation.mutateAsync({ shotId: 'deleted' });
    expect(client.getQueryData(key)).toEqual([{ id: 'kept' }]);
    expect(client.getQueryData(shotKeys.list('sequence-b'))).toEqual([
      { id: 'deleted' },
    ]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it('keeps the list when the delete fails', async () => {
    deleteShotFn.mockRejectedValue(new Error('delete failed'));
    const { client, key, mutation } = setup();
    await expect(mutation.mutateAsync({ shotId: 'deleted' })).rejects.toThrow(
      'delete failed'
    );
    expect(client.getQueryData(key)).toEqual([
      { id: 'deleted' },
      { id: 'kept' },
    ]);
  });

  it('does not let a fetch started before the delete restore the shot', async () => {
    deleteShotFn.mockResolvedValue(deleted);
    const { client, key, mutation } = setup();
    let finish: ((rows: { id: string }[]) => void) | undefined;
    const staleFetch = client
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<{ id: string }[]>((resolve) => {
            finish = resolve;
          }),
      })
      .catch(() => undefined);
    await mutation.mutateAsync({ shotId: 'deleted' });
    if (!finish) throw new Error('fetch did not start');
    finish([{ id: 'deleted' }, { id: 'kept' }]);
    await staleFetch;
    expect(client.getQueryData(key)).toEqual([{ id: 'kept' }]);
  });
});
