import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthState } from './openrouter-oauth';

vi.doMock('#env', () => ({
  getEnv: () => ({
    API_KEY_ENCRYPTION_KEY: 'test-secret-for-oauth-cookie-testing',
  }),
}));

const {
  getOAuthCookieClearHeader,
  getOAuthCookieName,
  getOAuthCookieOptions,
  OAUTH_STATE_TTL,
  sealOAuthState,
  unsealOAuthState,
} = await import('./openrouter-oauth-cookie');

const sampleState: OAuthState = {
  teamId: '01JTEAM00000000000000000000',
  userId: '01JUSER00000000000000000000',
  codeVerifier: 'verifier-abc123',
  csrfState: 'csrf-nonce-xyz789',
};

describe('openrouter-oauth-cookie', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('seal/unseal round-trip', () => {
    it('recovers the original state', async () => {
      const sealed = await sealOAuthState(sampleState);
      const unsealed = await unsealOAuthState(sealed);
      expect(unsealed).toEqual(sampleState);
    });

    it('produces different ciphertexts per call (random IV)', async () => {
      const a = await sealOAuthState(sampleState);
      const b = await sealOAuthState(sampleState);
      expect(a).not.toBe(b);
    });
  });

  describe('rejection paths', () => {
    it('returns null for garbage input', async () => {
      expect(await unsealOAuthState('not-a-sealed-value')).toBeNull();
      expect(await unsealOAuthState('')).toBeNull();
      expect(await unsealOAuthState('a.b')).toBeNull();
    });

    it('returns null for tampered ciphertext', async () => {
      const sealed = await sealOAuthState(sampleState);
      const [iv, ciphertext, tag] = sealed.split('.');
      if (!iv || !ciphertext || !tag) throw new Error('bad sealed format');
      // Flip the first character of the ciphertext
      const flipped = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
      expect(await unsealOAuthState([iv, flipped, tag].join('.'))).toBeNull();
    });

    it('returns null once the TTL has elapsed', async () => {
      vi.useFakeTimers();
      const sealed = await sealOAuthState(sampleState);
      vi.advanceTimersByTime((OAUTH_STATE_TTL + 1) * 1000);
      expect(await unsealOAuthState(sealed)).toBeNull();
    });

    it('still unseals just before the TTL elapses', async () => {
      vi.useFakeTimers();
      const sealed = await sealOAuthState(sampleState);
      vi.advanceTimersByTime((OAUTH_STATE_TTL - 1) * 1000);
      expect(await unsealOAuthState(sealed)).toEqual(sampleState);
    });
  });

  describe('cookie naming and options', () => {
    it('uses the __Host- prefix only on secure origins', () => {
      expect(getOAuthCookieName(true)).toBe('__Host-openrouter-oauth');
      expect(getOAuthCookieName(false)).toBe('openrouter-oauth');
    });

    it('sets HttpOnly, Lax, path=/ and the TTL', () => {
      expect(getOAuthCookieOptions(true)).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: OAUTH_STATE_TTL,
      });
    });

    it('builds a clearing header matching the set cookie attributes', () => {
      expect(getOAuthCookieClearHeader(true)).toBe(
        '__Host-openrouter-oauth=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure'
      );
      expect(getOAuthCookieClearHeader(false)).toBe(
        'openrouter-oauth=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'
      );
    });
  });
});
