/**
 * Welcome-grant unlock by SMS (#1539).
 *
 * Saving a card is impossible where wallets (WeChat Pay, …) rule, so the
 * claim dialog can verify a mobile number instead. Twilio Verify owns code
 * generation, expiry, attempt caps, per-number send caps and Fraud Guard —
 * we only relay to its two endpoints. One number unlocks one team, through
 * the same claims table as card fingerprints; the number itself is never
 * stored, only a hash.
 *
 * Off unless all three `TWILIO_*` vars are set (the dialog hides the option).
 */

import { getEnv } from '#env';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  ValidationError,
  WelcomeCardAlreadyClaimedError,
} from '@/shared/errors';
import { env as workerEnv } from 'cloudflare:workers';
import { z } from 'zod';
import { grantWelcomeCreditsForTeam } from './checkout';

function optionalEnv(name: string): string | undefined {
  const value = Reflect.get(getEnv(), name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function twilioConfig() {
  const accountSid = optionalEnv('TWILIO_ACCOUNT_SID');
  const authToken = optionalEnv('TWILIO_AUTH_TOKEN');
  const serviceSid = optionalEnv('TWILIO_VERIFY_SERVICE_SID');
  if (!accountSid || !authToken || !serviceSid) return null;
  return { accountSid, authToken, serviceSid };
}

export function isPhoneVerificationEnabled(): boolean {
  return twilioConfig() !== null;
}

/** E.164: `+` then 8–15 digits. Spaces, dashes, dots and parens are stripped. */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
    throw new ValidationError(
      'Enter your mobile number with the country code, like +1 555 123 4567'
    );
  }
  return digits;
}

async function phoneClaimFingerprint(phoneNumber: string): Promise<string> {
  const bytes = new TextEncoder().encode(`phone:${phoneNumber}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `phone:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// `status` is "pending" / "approved" on success and the HTTP number on errors.
const twilioBody = z.object({
  status: z.string().or(z.number()).optional(),
  code: z.number().optional(),
  message: z.string().optional(),
});

/** Twilio error codes worth a specific sentence. Anything else is generic. */
const TWILIO_MESSAGES: Record<number, string> = {
  20404: 'That code has expired. Send a new one.',
  60200: 'That does not look like a mobile number.',
  60202: 'Too many wrong codes. Send a new one.',
  60203: 'Too many codes sent to this number. Try again later.',
  60205: 'That number cannot receive SMS.',
};

async function twilioPost(
  path: 'Verifications' | 'VerificationChecks',
  form: Record<string, string>
): Promise<z.infer<typeof twilioBody>> {
  const config = twilioConfig();
  if (!config)
    throw new ValidationError('Phone verification is not configured');
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${config.serviceSid}/${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form),
    }
  );
  const body = twilioBody.parse(await response.json().catch(() => ({})));
  if (!response.ok) {
    const known = body.code != null ? TWILIO_MESSAGES[body.code] : undefined;
    if (known) throw new ValidationError(known);
    throw new Error(
      `Twilio Verify ${path} failed: ${response.status} ${body.message ?? ''}`
    );
  }
  return body;
}

export async function sendPhoneVerification(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  phoneNumber: string;
}): Promise<void> {
  if (await opts.scopedDb.billing.hasSignupGrant()) {
    throw new ValidationError('Welcome credits are already unlocked');
  }
  // ponytail: reuses the 30/min device-login limiter keyed per team so one
  // account cannot fan SMS out; Twilio's per-number caps + Fraud Guard cover
  // the rest. Add a dedicated tighter binding if SMS spend ever spikes.
  const { success } = await workerEnv.DEVICE_LOGIN_RATE_LIMITER.limit({
    key: `welcome-sms:${opts.teamId}`,
  });
  if (!success)
    throw new ValidationError('Too many codes sent. Try again in a minute.');

  await twilioPost('Verifications', { To: opts.phoneNumber, Channel: 'sms' });
}

export async function verifyPhoneAndGrant(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  phoneNumber: string;
  code: string;
}): Promise<{ granted: boolean }> {
  const check = await twilioPost('VerificationChecks', {
    To: opts.phoneNumber,
    Code: opts.code,
  });
  if (check.status !== 'approved') {
    throw new ValidationError('Wrong code. Check the SMS and try again.');
  }
  try {
    return await grantWelcomeCreditsForTeam({
      scopedDb: opts.scopedDb,
      teamId: opts.teamId,
      userId: opts.userId,
      source: 'phone',
      fingerprint: await phoneClaimFingerprint(opts.phoneNumber),
    });
  } catch (err) {
    if (err instanceof WelcomeCardAlreadyClaimedError) {
      throw new WelcomeCardAlreadyClaimedError(
        'This number has already been used to claim welcome credits'
      );
    }
    throw err;
  }
}
