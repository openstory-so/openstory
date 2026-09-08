import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/db/scoped';
import { isWelcomeCardAlreadyClaimedError } from '@/shared/errors';
import { WelcomeCardAlreadyClaimedError } from '@/shared/errors';

const env: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({ getEnv: () => env }));

const limit = vi.fn(async () => ({ success: true }));
vi.doMock('cloudflare:workers', () => ({
  env: { DEVICE_LOGIN_RATE_LIMITER: { limit } },
}));

const grant = vi.fn(async (_opts: { source: string; fingerprint: string }) => ({
  granted: true,
}));
vi.doMock('@/lib/billing/checkout', () => ({
  grantWelcomeCreditsForTeam: grant,
}));

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

const {
  isPhoneVerificationEnabled,
  normalizePhoneNumber,
  sendPhoneVerification,
  verifyPhoneAndGrant,
} = await import('./phone-verification');

const twilioEnv = () => {
  env.TWILIO_ACCOUNT_SID = 'AC1';
  env.TWILIO_AUTH_TOKEN = 'tok';
  env.TWILIO_VERIFY_SERVICE_SID = 'VA1';
};

function scopedDb(hasSignupGrant: boolean): ScopedDb {
  const stub = { billing: { hasSignupGrant: async () => hasSignupGrant } };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only reaches billing.hasSignupGrant
  return stub as unknown as ScopedDb;
}

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status })
  );

describe('phone verification', () => {
  it('is off until all three Twilio vars are set', () => {
    env.TWILIO_ACCOUNT_SID = 'AC1';
    env.TWILIO_AUTH_TOKEN = undefined;
    expect(isPhoneVerificationEnabled()).toBe(false);
    twilioEnv();
    expect(isPhoneVerificationEnabled()).toBe(true);
  });

  it('normalises to E.164 and rejects the rest', () => {
    expect(normalizePhoneNumber(' +1 (555) 123-4567 ')).toBe('+15551234567');
    expect(() => normalizePhoneNumber('5551234567')).toThrow(/country code/);
    expect(() => normalizePhoneNumber('+1 555')).toThrow(/country code/);
  });

  it('refuses to text a team that already has the grant', async () => {
    twilioEnv();
    await expect(
      sendPhoneVerification({
        scopedDb: scopedDb(true),
        teamId: 't1',
        phoneNumber: '+15551234567',
      })
    ).rejects.toThrow(/already unlocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a Verification and surfaces Twilio codes as user copy', async () => {
    twilioEnv();
    reply(201, { status: 'pending' });
    await sendPhoneVerification({
      scopedDb: scopedDb(false),
      teamId: 't1',
      phoneNumber: '+15551234567',
    });
    const request = fetchMock.mock.calls[0]?.[0];
    if (!request) throw new Error('fetch not called');
    expect(request.url).toBe(
      'https://verify.twilio.com/v2/Services/VA1/Verifications'
    );
    expect(await request.text()).toBe('To=%2B15551234567&Channel=sms');
    expect(limit).toHaveBeenCalledWith({ key: 'welcome-sms:t1' });

    reply(400, { code: 60200, message: 'Invalid parameter', status: 400 });
    await expect(
      sendPhoneVerification({
        scopedDb: scopedDb(false),
        teamId: 't1',
        phoneNumber: '+15551234567',
      })
    ).rejects.toThrow(/mobile number/);
  });

  it('grants on an approved check with a hashed fingerprint, never the number', async () => {
    twilioEnv();
    reply(200, { status: 'approved' });
    const result = await verifyPhoneAndGrant({
      scopedDb: scopedDb(false),
      teamId: 't1',
      userId: 'u1',
      phoneNumber: '+15551234567',
      code: '123456',
    });
    expect(result).toEqual({ granted: true });
    const args = grant.mock.calls[0]?.[0];
    if (!args) throw new Error('grant not called');
    expect(args.source).toBe('phone');
    expect(args.fingerprint).toMatch(/^phone:[0-9a-f]{64}$/);
    expect(args.fingerprint).not.toContain('555');
  });

  it('rejects a pending check and rewords a reused number', async () => {
    twilioEnv();
    reply(200, { status: 'pending' });
    await expect(
      verifyPhoneAndGrant({
        scopedDb: scopedDb(false),
        teamId: 't1',
        userId: 'u1',
        phoneNumber: '+15551234567',
        code: '000000',
      })
    ).rejects.toThrow(/Wrong code/);

    reply(200, { status: 'approved' });
    grant.mockRejectedValueOnce(new WelcomeCardAlreadyClaimedError());
    const err: unknown = await verifyPhoneAndGrant({
      scopedDb: scopedDb(false),
      teamId: 't1',
      userId: 'u1',
      phoneNumber: '+15551234567',
      code: '123456',
    }).catch((e: unknown) => e);
    expect(isWelcomeCardAlreadyClaimedError(err)).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/number/);
  });
});
