import { describe, expect, it, vi } from 'vitest';

vi.doMock('#env', () => ({
  getEnv: () => ({
    API_KEY_ENCRYPTION_KEY: 'test-secret-for-encryption-testing',
  }),
}));

const { encryptApiKey, decryptApiKey, getKeyHint } =
  await import('./api-key-encryption');

describe('api-key-encryption', () => {
  describe('encrypt/decrypt round-trip', () => {
    it('recovers the original plaintext', async () => {
      const original = 'sk-or-v1-abc123def456';
      const encrypted = await encryptApiKey(original);
      const decrypted = await decryptApiKey(encrypted);
      expect(decrypted).toBe(original);
    });

    it('handles empty string', async () => {
      const encrypted = await encryptApiKey('');
      const decrypted = await decryptApiKey(encrypted);
      expect(decrypted).toBe('');
    });

    it('handles short key', async () => {
      const encrypted = await encryptApiKey('ab');
      const decrypted = await decryptApiKey(encrypted);
      expect(decrypted).toBe('ab');
    });

    it('handles long key with special characters', async () => {
      const original =
        'sk_live_51H!@#$%^&*()_+-=[]{}|;:,.<>?/~`' + 'x'.repeat(200);
      const encrypted = await encryptApiKey(original);
      const decrypted = await decryptApiKey(encrypted);
      expect(decrypted).toBe(original);
    });
  });

  describe('unique IVs', () => {
    it('produces different ciphertext for the same plaintext', async () => {
      const plaintext = 'sk-or-v1-same-key';
      const a = await encryptApiKey(plaintext);
      const b = await encryptApiKey(plaintext);

      expect(a.keyIv).not.toBe(b.keyIv);
      expect(a.encryptedKey).not.toBe(b.encryptedKey);
    });
  });

  describe('getKeyHint', () => {
    it('returns masked hint with last 4 chars for normal keys', () => {
      expect(getKeyHint('sk-or-v1-abc123')).toBe('****c123');
    });

    it('returns **** for keys with 4 or fewer chars', () => {
      expect(getKeyHint('abcd')).toBe('****');
      expect(getKeyHint('ab')).toBe('****');
      expect(getKeyHint('')).toBe('****');
    });
  });
});

describe('api-key-encryption missing env', () => {
  it('throws when API_KEY_ENCRYPTION_KEY is not set', async () => {
    // Re-mock with missing key. resetModules() drops the cached api-key-encryption
    // module so the dynamic import below re-evaluates against the new env mock.
    vi.resetModules();
    vi.doMock('#env', () => ({
      getEnv: () => ({}),
    }));
    const mod = await import('./api-key-encryption');
    await expect(mod.encryptApiKey('test')).rejects.toThrow(
      'API_KEY_ENCRYPTION_KEY environment variable is required'
    );
  });
});
