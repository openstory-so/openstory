import { describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';

const deviceToken = vi.fn();
const createApiKey = vi.fn();
const findSession = vi.fn();
const deleteSession = vi.fn();
const resolveUserTeam = vi.fn();

vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({
    api: { deviceToken, createApiKey },
    $context: Promise.resolve({
      internalAdapter: { findSession, deleteSession },
    }),
  }),
}));
vi.doMock('@/lib/db/scoped', () => ({ resolveUserTeam }));

const { exchangeDeviceCode } = await import('./device-auth');

const pluginError = (error: string) =>
  new APIError('BAD_REQUEST', { error, error_description: error });

describe('exchangeDeviceCode', () => {
  it.each([
    'authorization_pending',
    'slow_down',
    'expired_token',
    'access_denied',
  ])('maps plugin %s to a status', async (code) => {
    deviceToken.mockRejectedValueOnce(pluginError(code));
    await expect(exchangeDeviceCode('dc')).resolves.toEqual({ status: code });
  });

  it('reads unknown codes as expired_token (no existence oracle)', async () => {
    deviceToken.mockRejectedValueOnce(pluginError('invalid_grant'));
    await expect(exchangeDeviceCode('nope')).resolves.toEqual({
      status: 'expired_token',
    });
  });

  it('rethrows non-plugin errors', async () => {
    deviceToken.mockRejectedValueOnce(new Error('db down'));
    await expect(exchangeDeviceCode('dc')).rejects.toThrow('db down');
  });

  it('swaps the approved session for a team-scoped API key and drops the session', async () => {
    deviceToken.mockResolvedValueOnce({ access_token: 'sess-token' });
    findSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} });
    resolveUserTeam.mockResolvedValueOnce({
      teamId: 't1',
      teamName: 'Team One',
    });
    createApiKey.mockResolvedValueOnce({ key: 'osk_secret' });

    await expect(exchangeDeviceCode('dc')).resolves.toEqual({
      status: 'approved',
      apiKey: 'osk_secret',
      team: { id: 't1', name: 'Team One' },
    });
    expect(deleteSession).toHaveBeenCalledWith('sess-token');
    expect(createApiKey).toHaveBeenCalledWith({
      body: expect.objectContaining({ userId: 'u1', prefix: 'osk_' }),
    });
    expect(createApiKey.mock.calls[0]?.[0].body.name).toMatch(
      /^Agent login · \d{4}-\d{2}-\d{2}$/
    );
  });
});

describe('exchangeDeviceCode failures after the plugin consumed the code', () => {
  it('surfaces OAuth error_description instead of an empty message', async () => {
    deviceToken.mockRejectedValueOnce(
      new APIError('INTERNAL_SERVER_ERROR', {
        error: 'server_error',
        error_description: 'User not found',
      })
    );
    await expect(exchangeDeviceCode('dc')).rejects.toThrow('User not found');
  });

  it('drops the carrier session even when it cannot be found', async () => {
    deviceToken.mockResolvedValueOnce({ access_token: 'gone' });
    findSession.mockResolvedValueOnce(null);
    await expect(exchangeDeviceCode('dc')).rejects.toThrow('vanished');
    expect(deleteSession).toHaveBeenCalledWith('gone');
  });
});
