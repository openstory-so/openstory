/**
 * API Key Encryption Module
 * AES-256-GCM encryption for user-provided API keys
 *
 * Keys are encrypted at rest in the database. The encryption key
 * lives in environment variables (Cloudflare Workers secrets),
 * separate from the database. A database breach alone does not
 * reveal user API keys.
 */

import { getEnv } from '#env';

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for AES-GCM
const TAG_LENGTH = 128; // bits

/**
 * Derive a CryptoKey from the environment encryption secret.
 * Uses HKDF to derive a proper AES key from the secret string.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = getEnv().API_KEY_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'API_KEY_ENCRYPTION_KEY environment variable is required for API key encryption'
    );
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('openstory-api-key-encryption'),
      info: new TextEncoder().encode('aes-256-gcm'),
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

export type EncryptedApiKey = {
  encryptedKey: string; // base64-encoded ciphertext
  keyIv: string; // base64-encoded IV
  keyTag: string; // base64-encoded auth tag (embedded in GCM ciphertext)
};

/**
 * Encrypt an API key for storage in the database.
 * Uses AES-256-GCM with a random IV per key.
 */
export async function encryptApiKey(
  plaintext: string
): Promise<EncryptedApiKey> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encoded
  );

  // AES-GCM appends the auth tag to the ciphertext
  // Split them for storage: ciphertext | tag (last 16 bytes)
  const cipherArray = new Uint8Array(cipherBuffer);
  const tagBytes = 16; // TAG_LENGTH / 8
  const ciphertext = cipherArray.slice(0, cipherArray.length - tagBytes);
  const tag = cipherArray.slice(cipherArray.length - tagBytes);

  return {
    encryptedKey: uint8ToBase64(ciphertext),
    keyIv: uint8ToBase64(iv),
    keyTag: uint8ToBase64(tag),
  };
}

/**
 * Decrypt an API key from the database.
 */
export async function decryptApiKey(
  encrypted: EncryptedApiKey
): Promise<string> {
  const key = await getEncryptionKey();
  const iv = base64ToUint8(encrypted.keyIv);
  const ciphertext = base64ToUint8(encrypted.encryptedKey);
  const tag = base64ToUint8(encrypted.keyTag);

  // Reconstruct the combined ciphertext+tag that AES-GCM expects
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: new Uint8Array(iv), tagLength: TAG_LENGTH },
    key,
    new Uint8Array(combined)
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Extract a display hint from an API key (last 4 chars).
 * Safe to store unencrypted for UI display.
 */
export function getKeyHint(apiKey: string): string {
  if (apiKey.length <= 4) return '****';
  return `${'*'.repeat(4)}${apiKey.slice(-4)}`;
}

// -- Base64 helpers (works in Node, Bun, and Cloudflare Workers) --

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error(`Byte at index ${i} is undefined`);
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
