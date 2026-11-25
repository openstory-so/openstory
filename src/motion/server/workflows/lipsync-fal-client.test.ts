import { describe, expect, it, vi } from 'vitest';

type Client = { credentials: string; submit: ReturnType<typeof vi.fn> };
const clients: Client[] = [];
const sharedConfig = vi.fn();

vi.doMock('@fal-ai/client', () => ({
  fal: { config: sharedConfig },
  createFalClient: (config: { credentials: string }) => {
    const client: Client = { credentials: config.credentials, submit: vi.fn() };
    clients.push(client);
    return { queue: { submit: client.submit } };
  },
}));

const { lipsyncFalClient } = await import('./lipsync-workflow');

/** A key that resolves only when released, so two runs can interleave. */
function slowKey(key: string) {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    credentials: {
      resolveKey: async () => {
        await ready;
        return { key, source: 'organization' as const };
      },
    },
  };
}

describe('lipsyncFalClient', () => {
  it('keeps two interleaved runs on their own keys', async () => {
    const a = slowKey('key-a');
    const b = slowKey('key-b');
    const runA = lipsyncFalClient(a.credentials).then(({ fal }) =>
      fal.queue.submit('fal-ai/sync-lipsync/v3', { input: { run: 'a' } })
    );
    const runB = lipsyncFalClient(b.credentials).then(({ fal }) =>
      fal.queue.submit('fal-ai/sync-lipsync/v3', { input: { run: 'b' } })
    );
    // B's key lands first, then A's: a shared client would now hold A's key for both.
    b.release();
    await Promise.resolve();
    a.release();
    await Promise.all([runA, runB]);

    const byKey = Object.fromEntries(
      clients.map((client) => [
        client.credentials,
        client.submit.mock.calls.map(([, options]) => options.input.run),
      ])
    );
    expect(byKey).toEqual({ 'key-a': ['a'], 'key-b': ['b'] });
    expect(sharedConfig).not.toHaveBeenCalled();
  });
});
