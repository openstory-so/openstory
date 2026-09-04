import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const limit = vi.fn();
const handler = vi.fn(
  async () => new Response(JSON.stringify({ client_id: 'c1' }), { status: 201 })
);
const pruneOrphanedOAuthClients = vi.fn();
const scheduleFlushAnalytics = vi.fn();

vi.doMock('cloudflare:workers', () => ({
  env: { DEVICE_LOGIN_RATE_LIMITER: { limit } },
}));
vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({ handler }),
}));
vi.doMock('@/lib/db/scoped', () => ({
  pruneOrphanedOAuthClients,
}));
vi.doMock('#flush-scheduler', () => ({ scheduleFlushAnalytics }));

const { Route } = await import('./$');

type Handler = (ctx: { request: Request }) => Promise<Response>;
const post = z
  .object({ POST: z.custom<Handler>((v) => typeof v === 'function') })
  .parse(Route.options.server?.handlers).POST;

const register = (path = '/api/auth/oauth2/register') =>
  post({
    request: new Request(`https://x${path}`, { method: 'POST' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockResolvedValue({ success: true });
  pruneOrphanedOAuthClients.mockResolvedValue(0);
  handler.mockResolvedValue(
    new Response(JSON.stringify({ client_id: 'c1' }), { status: 201 })
  );
});

describe('POST /api/auth/oauth2/register', () => {
  it('429s when the per-IP limiter trips and does not call the auth handler', async () => {
    limit.mockResolvedValueOnce({ success: false });
    const res = await register();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(handler).not.toHaveBeenCalled();
  });

  it('prunes orphans then registers when the limiter allows it', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(pruneOrphanedOAuthClients).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('still registers when prune throws', async () => {
    pruneOrphanedOAuthClients.mockRejectedValueOnce(new Error('D1 down'));
    const res = await register();
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalled();
  });

  it('does not rate-limit non-register auth paths', async () => {
    const res = await post({
      request: new Request('https://x/api/auth/sign-in/email', {
        method: 'POST',
      }),
    });
    expect(res.status).toBe(201);
    expect(limit).not.toHaveBeenCalled();
    expect(pruneOrphanedOAuthClients).not.toHaveBeenCalled();
  });
});
