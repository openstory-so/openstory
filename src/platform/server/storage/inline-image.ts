/**
 * Inline-bytes shim for generated stills (#1638).
 *
 * Cloudflare Workflows persists every `step.do` result into its durable
 * checkpoint at 1 MiB, and some vias hand the image back as inline base64
 * with no hosted URL at all: native Gemini (Nano Banana) always does,
 * BytePlus can. A 16:9 1K PNG base64-encodes past that cap, so the
 * generation SUCCEEDS and the checkpoint fails — `Step
 * generate-reference-image-1 output is too large. Maximum allowed size is
 * 1MiB.` The video side has guarded this since Omni Flash
 * (`videoUrlFitsWorkflowCheckpoint`); images had no equivalent.
 *
 * {@link stashBase64Image} parks those bytes in R2 from INSIDE the
 * generating step, so the result that gets checkpointed is a short URL
 * whatever the via returned. The object is a scratch copy under
 * `thumbnails/scratch/` — the caller's own upload step re-stores the image
 * under its final key, and nothing sweeps the prefix today (same standing
 * gap as `uploads/`, see `api-v1/safe-fetch.ts`).
 *
 * {@link fetchGeneratedImage} is the read half those upload steps need: a
 * stored `/r2/` URL is origin-relative (#894) and so is not fetchable at
 * all, and workerd's `fetch` does not read `data:` either. Anything else —
 * a provider CDN URL — is a plain fetch, unchanged.
 *
 * On memory: the stash cannot stream. Its input is a base64 STRING the
 * provider SDK has already parsed out of a JSON body, so the bytes are
 * resident before this module is reached and one decode is the floor —
 * which is why `image-generation` hands the payload straight here instead
 * of minting a `data:` URI for this module to parse back apart. The `/r2/`
 * read is the path that CAN stream, and does: `openStorageObject` hands
 * `uploadResponse` a body and a length, and the bytes go binding to
 * binding.
 */

import { generateId } from '@/platform/id';
import { openStorageObject, uploadFile } from '#storage';
import { r2KeyFromUrl, STORAGE_BUCKETS } from './buckets';
import { getExtensionFromMimeType, sniffImageMimeType } from './file';

const DATA_URI = /^data:([^;,]+);base64,(.*)$/;

/** True for a provider result delivered as inline bytes, not a URL. */
export function isDataImageUrl(url: string): boolean {
  return url.startsWith('data:');
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeDataImageUri(url: string): {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
} {
  const match = DATA_URI.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(
      'Malformed image data URI; expected data:<mime>;base64,<payload>'
    );
  }
  const bytes = decodeBase64(match[2]);
  // Trust the bytes over the declared type, as `readStoredBytes` does: a
  // mislabelled image is rejected by vision APIs downstream (#1218).
  return { bytes, contentType: sniffImageMimeType(bytes) ?? match[1] };
}

/**
 * Park a provider's inline base64 image in R2 and return its stored `/r2/`
 * URL, so the value can cross a workflow step boundary.
 *
 * Takes the raw payload, not a `data:` URI: the caller has the base64 in
 * hand, and wrapping it in a URI only to regex it apart here would add a
 * second full-size string for nothing.
 */
export async function stashBase64Image(
  base64: string,
  declaredType: string
): Promise<string> {
  const bytes = decodeBase64(base64);
  const contentType = sniffImageMimeType(bytes) ?? declaredType;
  const extension = getExtensionFromMimeType(contentType) ?? 'png';
  const result = await uploadFile(
    STORAGE_BUCKETS.THUMBNAILS,
    `scratch/${generateId()}.${extension}`,
    bytes,
    { contentType, upsert: true }
  );
  return result.publicUrl;
}

/**
 * Open a generated image as a fetch `Response` for upload to its final key.
 * Handles the two forms a plain `fetch` cannot: our own origin-relative
 * `/r2/` URLs and inline `data:` bytes.
 *
 * The `/r2/` case streams — body and length come straight off the R2
 * object, so `uploadResponse` pipes binding to binding through
 * `FixedLengthStream` without materialising the image.
 */
export async function fetchGeneratedImage(url: string): Promise<Response> {
  if (isDataImageUrl(url)) {
    const { bytes, contentType } = decodeDataImageUri(url);
    return new Response(bytes, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
      },
    });
  }

  const key = r2KeyFromUrl(url);
  if (key !== null) {
    const object = await openStorageObject(key);
    if (!object) {
      throw new Error(`Generated image not found in storage: ${url}`);
    }
    return new Response(object.body, {
      headers: {
        'Content-Type': object.contentType || 'image/png',
        'Content-Length': String(object.size),
      },
    });
  }

  return fetch(url);
}
