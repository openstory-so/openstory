/**
 * Hashing helpers for compliance records (#1180).
 *
 * Everything here uses WebCrypto's SHA-256, available in Workerd and Node
 * alike, so the same code runs in a workflow step, a server fn, and a test.
 *
 * Why compliance records store hashes instead of the values:
 *
 *  - A prompt hash proves which prompt produced an asset without keeping a
 *    second, divergent copy of user content.
 *  - An attestation-statement hash pins the exact wording a user agreed to,
 *    so a later edit to the wording cannot be read back onto an old consent.
 */

const encoder = /* @__PURE__ */ new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(digest);
}
