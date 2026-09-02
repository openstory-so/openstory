/**
 * Auth Options Server Function
 * Reports which sign-in options the server offers, in one round-trip awaited
 * by the /_auth route's beforeLoad (and queried by the auth-gate dialog) so
 * the login form renders the right options straight away:
 * - googleAuthEnabled: GOOGLE_CLIENT_ID/SECRET configured, so the Google
 *   button works (isGoogleAuthConfigured).
 * - devFixedOtp: the dev fixed-OTP sign-in is active (see devFixedOtp in
 *   src/lib/auth/config.ts). Always false in production builds, where
 *   `import.meta.env.DEV` is define-replaced — this discloses nothing.
 */

import { isDevFixedOtpActive } from '@/lib/auth/config';
import { isGoogleAuthConfigured } from '@/shared/utils/environment';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

export type AuthOptions = {
  googleAuthEnabled: boolean;
  devFixedOtp: boolean;
};

export const getAuthOptionsFn = createServerFn({ method: 'GET' }).handler(
  (): AuthOptions => ({
    googleAuthEnabled: isGoogleAuthConfigured(),
    devFixedOtp: isDevFixedOtpActive(getRequest()),
  })
);
