import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const exchangeDeviceCode = vi.fn();
const limit = vi.fn();
const deviceCode = vi.fn();
const prune = vi.fn();

vi.doMock('cloudflare:workers', () => ({
  env: { DEVICE_LOGIN_RATE_LIMITER: { limit } },
}));
vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({ api: { deviceCode } }),
}));
vi.doMock('@/lib/db/scoped', () => ({
  resolveUserTeam: vi.fn(),
  pruneExpiredDeviceCodes: prune,
}));

const real = await import('@/lib/api-v1/device-auth');
vi.doMock('@/lib/api-v1/device-auth', () => ({ ...real, exchangeDeviceCode }));

const { Route: TokenRoute } = await import('@/routes/api/v1/device.token');
const { Route: CodeRoute } = await import('@/routes/api/v1/device.code');

type Handler = (ctx: { request: Request }) => Promise<Response>;
const handlerSchema = z.custom<Handler>((v) => typeof v === 'function');
const getToken = z
  .object({ GET: handlerSchema })
  .parse(TokenRoute.options.server?.handlers).GET;
const postCode = z
  .object({ POST: handlerSchema })
  .parse(CodeRoute.options.server?.handlers).POST;

const token = (qs: string) =>
  getToken({ request: new Request(`http://x/api/v1/device/token${qs}`) });

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockResolvedValue({ success: true });
});

describe('GET /api/v1/device/token', () => {
  it('400s without device_code and does not poll', async () => {
    const res = await token('');
    expect(res.status).toBe(400);
    expect(exchangeDeviceCode).not.toHaveBeenCalled();
  });

  it.each([
    ['authorization_pending', 428],
    ['access_denied', 403],
    ['expired_token', 410],
    ['slow_down', 429],
  ])('maps %s to %i on a bare poll', async (status, code) => {
    exchangeDeviceCode.mockResolvedValueOnce({ status });
    const res = await token('?device_code=dc');
    expect(res.status).toBe(code);
    const body = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(await res.json());
    expect(body.error.code).toBe(status);
  });

  it('sets Retry-After on slow_down', async () => {
    exchangeDeviceCode.mockResolvedValueOnce({ status: 'slow_down' });
    const res = await token('?device_code=dc');
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  it('reports slow_down during ?wait as pending (server paced itself)', async () => {
    vi.useFakeTimers();
    exchangeDeviceCode.mockResolvedValue({ status: 'slow_down' });
    const p = token('?device_code=dc&wait=1s');
    await vi.advanceTimersByTimeAsync(1_100);
    vi.useRealTimers();
    expect((await p).status).toBe(428);
  });

  it('returns the key once approved, uncached', async () => {
    exchangeDeviceCode.mockResolvedValueOnce({
      status: 'approved',
      apiKey: 'osk_x',
      team: { id: 't', name: 'T' },
    });
    const res = await token('?device_code=dc');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      api_key: 'osk_x',
      team: { id: 't', name: 'T' },
    });
  });

  it('429s with Retry-After when the per-IP limiter trips', async () => {
    limit.mockResolvedValueOnce({ success: false });
    const res = await token('?device_code=dc');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(exchangeDeviceCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/device/code', () => {
  it('derives URLs from the request origin and links the poll', async () => {
    deviceCode.mockResolvedValueOnce({
      device_code: 'd/c',
      user_code: 'ABCDEFGH',
      expires_in: 600,
      interval: 5,
    });
    const res = await postCode({
      request: new Request('https://pr-9.example/api/v1/device/code', {
        method: 'POST',
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = z
      .object({
        verification_url: z.string(),
        verification_url_complete: z.string(),
        _links: z.object({ poll: z.object({ href: z.string() }) }),
      })
      .parse(await res.json());
    expect(body.verification_url).toBe('https://pr-9.example/device');
    expect(body.verification_url_complete).toBe(
      'https://pr-9.example/device?user_code=ABCDEFGH'
    );
    expect(body._links.poll.href).toBe(
      '/api/v1/device/token?device_code=d%2Fc{&wait}'
    );
    expect(prune).toHaveBeenCalled();
  });
});
