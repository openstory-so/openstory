import { getEnv } from '#env';
import type { EnvVarName } from '@/platform/server/env/environment';

/**
 * Fixed sign-in code for the one account plugin-directory reviewers use
 * (#2149). Reviewers sign in from typed details alone: they cannot read the
 * account's inbox or use a passkey, and we have no passwords. The address
 * (`REVIEW_LOGIN_EMAIL`) and the code (`REVIEW_LOGIN_CODE`) are secrets, so
 * neither appears in the repo. With no address set, nothing changes.
 *
 * The code is 6 letters and digits with at least one letter: the sign-in box
 * takes 6 characters, and 6 digits alone would be a million guesses.
 */
const REVIEW_CODE = /^(?=.*[A-Za-z])[A-Za-z0-9]{6}$/;

function secret(name: EnvVarName): string | undefined {
  return getEnv()[name]?.trim() || undefined;
}

export function isReviewLogin(email: string): boolean {
  const review = secret('REVIEW_LOGIN_EMAIL');
  return (
    review !== undefined && review.toLowerCase() === email.trim().toLowerCase()
  );
}

/** Throws rather than sign the review account in with a weak or missing code. */
export function reviewLoginCode(): string {
  const code = secret('REVIEW_LOGIN_CODE');
  if (!code || !REVIEW_CODE.test(code)) {
    throw new Error(
      'REVIEW_LOGIN_CODE must be 6 letters and digits with at least one letter'
    );
  }
  return code;
}
