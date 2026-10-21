import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({ getEnv: () => env }));

const { isReviewLogin, reviewLoginCode } = await import('./review-login');

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
});

describe('isReviewLogin', () => {
  it('is off when no review address is set', () => {
    expect(isReviewLogin('anyone@example.com')).toBe(false);
  });

  it('matches only the review address, ignoring case and spaces', () => {
    env.REVIEW_LOGIN_EMAIL = 'Reviewer@Example.com';
    expect(isReviewLogin(' reviewer@example.com ')).toBe(true);
    expect(isReviewLogin('someone@example.com')).toBe(false);
  });
});

describe('reviewLoginCode', () => {
  it('returns a code of 6 letters and digits', () => {
    env.REVIEW_LOGIN_CODE = 'a1B2c3';
    expect(reviewLoginCode()).toBe('a1B2c3');
  });

  it.each([undefined, '', '123456', 'abc12', 'abc1234', 'ab-123'])(
    'refuses %j',
    (code) => {
      env.REVIEW_LOGIN_CODE = code;
      expect(() => reviewLoginCode()).toThrow(/REVIEW_LOGIN_CODE/);
    }
  );
});
