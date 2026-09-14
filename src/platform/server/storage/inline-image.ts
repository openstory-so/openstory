/**
 * Open a generated image for upload, whatever form the provider returned it
 * in (#1638, #1645).
 *
 * Most vias hand back a hosted URL. Native Gemini (Nano Banana) always
 * answers with inline base64 instead, and BytePlus can — and workerd's
 * `fetch` does not read `data:`, so a bare fetch cannot reach those bytes.
 * R2 wants a body rather than a string, so one decode is unavoidable; this
 * is where it happens. The video side has the same shim in
 * `fetchVideoForUpload`.
 *
 * There is no size concern here: every caller stores the image inside the
 * same `step.do` that generated it, so nothing large ever reaches a
 * Workflows checkpoint.
 */

import { sniffImageMimeType } from './file';

const DATA_URI = /^data:([^;,]+);base64,(.*)$/;

/** True for a provider result delivered as inline bytes, not a URL. */
function isDataImageUrl(url: string): boolean {
  return url.startsWith('data:');
}

function responseFromDataUri(url: string): Response {
  const match = DATA_URI.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(
      'Malformed image data URI; expected data:<mime>;base64,<payload>'
    );
  }
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Trust the bytes over the declared type, as `readStoredBytes` does: a
  // mislabelled image is rejected by vision APIs downstream (#1218).
  const contentType = sniffImageMimeType(bytes) ?? match[1];
  return new Response(bytes, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
    },
  });
}

/** Open a generated image as a fetch `Response`, ready for `uploadResponse`. */
export function fetchGeneratedImage(url: string): Promise<Response> {
  return isDataImageUrl(url)
    ? Promise.resolve(responseFromDataUri(url))
    : fetch(url);
}
