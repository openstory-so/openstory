/**
 * Base64 for bytes, safe on the server and in the browser (no `Buffer`).
 *
 * Uses the ES2026 `Uint8Array.fromBase64` / `toBase64` where the runtime has
 * them — workerd and current browsers do — which decode straight into one
 * buffer with no intermediate string. The chunked fallback keeps the same
 * memory shape: it never builds a binary string as long as the payload.
 *
 * ponytail: the fallback exists for Node 24 (the pinned engine, which lacks
 * the natives) and older browsers; delete it once both are past.
 */

/** The lib types claim the natives always exist; Node 24 has neither. */
const NATIVE: boolean = 'fromBase64' in Uint8Array;

/** base64 characters per `atob` — a multiple of 4, so no group is split. */
const DECODE_SLICE_CHARS = 4 * 8192;

/** Bytes per `btoa` — a multiple of 3, so only the last piece is padded. */
const ENCODE_SLICE_BYTES = 3 * 8192;

/** Decode base64 into one buffer. ASCII whitespace is skipped. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (NATIVE) return Uint8Array.fromBase64(input);
  // `atob` skips whitespace, which would shift a slice off its 4-character
  // groups. Providers do not send any; the scan is what makes that safe to
  // rely on, and the copy is only paid when it is wrong.
  const base64 = /\s/.test(input) ? input.replace(/\s+/g, '') : input;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor((base64.length * 3) / 4) - padding);
  let at = 0;
  for (let from = 0; from < base64.length; from += DECODE_SLICE_CHARS) {
    const binary = atob(base64.slice(from, from + DECODE_SLICE_CHARS));
    // Written past the end is dropped by the typed array; caught just below.
    for (let i = 0; i < binary.length; i++) out[at + i] = binary.charCodeAt(i);
    at += binary.length;
  }
  if (at !== out.length) {
    // A stray character shifted a group: the bytes are garbage.
    throw new SyntaxError(
      `base64 decodes to ${at} bytes, expected ${out.length}`
    );
  }
  return out;
}

/** Encode bytes as padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (NATIVE) return bytes.toBase64();
  const parts: string[] = [];
  for (let from = 0; from < bytes.length; from += ENCODE_SLICE_BYTES) {
    const slice = bytes.subarray(from, from + ENCODE_SLICE_BYTES);
    parts.push(btoa(String.fromCharCode(...slice)));
  }
  return parts.join('');
}
