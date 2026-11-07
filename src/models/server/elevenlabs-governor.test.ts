import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsGovernor } from './elevenlabs-governor.do';
import { asStub } from '@/test/as-stub';

const capture = vi.fn();
vi.doMock('@/platform/server/observability/posthog-server', () => ({
  getPostHogClient: () => ({ capture }),
}));

let governor: ElevenLabsGovernor;
const namespace = {
  idFromName: () => 'id',
  get: () => ({
    acquire: async (input: Parameters<ElevenLabsGovernor['acquire']>[0]) =>
      governor.acquire(input, Date.now()),
    release: async (holder: string) => governor.release(holder, Date.now()),
  }),
};
vi.doMock('#env', () => ({
  getEnv: () => ({ ELEVENLABS_GOVERNOR: namespace }),
}));

const { withElevenLabsSlot } = await import('./elevenlabs-governor');

const call = { operation: 'voice design', attempt: 1, lastAttempt: false };

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const store = new Map<string, unknown>();
  governor = new ElevenLabsGovernor(
    // the DO reads only ctx.storage.kv
    asStub<DurableObjectState>({
      storage: {
        kv: {
          get: (key: string) => store.get(key),
          put: (key: string, value: unknown) => void store.set(key, value),
        },
      },
    }),
    // the DO reads no env
    asStub<Cloudflare.Env>({})
  );
  capture.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withElevenLabsSlot', () => {
  it('runs a third call only after one of two in flight finishes', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const third = vi.fn(async () => 'third');
    const a = withElevenLabsSlot(call, () => first.promise);
    const b = withElevenLabsSlot(call, () => second.promise);
    const c = withElevenLabsSlot(call, third);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(third).not.toHaveBeenCalled();

    first.resolve();
    await a;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(c).resolves.toBe('third');
    second.resolve();
    await b;
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'elevenlabs_concurrency_backoff',
        properties: expect.objectContaining({ cause: 'queued' }),
      })
    );
  });

  it('gives the slot back when the call throws', async () => {
    const boom = new Error('boom');
    await expect(
      withElevenLabsSlot(call, () => Promise.reject(boom))
    ).rejects.toBe(boom);
    await expect(withElevenLabsSlot(call, async () => 'a')).resolves.toBe('a');
    await expect(withElevenLabsSlot(call, async () => 'b')).resolves.toBe('b');
    expect(capture).not.toHaveBeenCalled();
  });

  it('reports a 429 and rethrows it for the step retry', async () => {
    const limited = Object.assign(new Error('concurrent_limit_exceeded'), {
      statusCode: 429,
    });
    await expect(
      withElevenLabsSlot({ ...call, attempt: 7, lastAttempt: true }, () =>
        Promise.reject(limited)
      )
    ).rejects.toBe(limited);
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'system',
      event: 'elevenlabs_concurrency_backoff',
      properties: {
        operation: 'voice design',
        attempt: 7,
        cause: 'rejected',
        exhausted: true,
      },
    });
  });
});
