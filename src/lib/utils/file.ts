/**
 * File utilities — extension extraction and MIME type mapping.
 */

export function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return match?.[1]?.toLowerCase() || 'jpg';
  } catch {
    const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/);
    return match?.[1]?.toLowerCase() || 'jpg';
  }
}

export function getMimeTypeFromExtension(ext: string): string {
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Image MIME type sniffed from the leading magic bytes, or `null` when the
 * bytes aren't a format we recognise.
 *
 * Stored `contentType` is only ever the uploader's *guess*: fal's upscale
 * outputs are extension-less URLs, so `getExtensionFromUrl` defaults to `jpg`
 * and PNG bytes land in R2 as `<ulid>.jpg` / `image/jpeg`. Anthropic rejects a
 * vision part whose declared type disagrees with its bytes (HTTP 400 today;
 * historically an empty completion after a billed reasoning pass) — which is
 * what silently poisoned every recorded motion-prompt fixture (#1218). The
 * bytes are the only trustworthy source, so sniff them before declaring a type.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const b = (i: number): number | undefined => bytes[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
    return 'image/png';
  }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * File extension for a `Content-Type` header value, or `null` when it names no
 * image type we store. Inverse of {@link getMimeTypeFromExtension}, used to let
 * a provider's served content-type win over a guessed URL extension.
 */
export function getExtensionFromMimeType(
  contentType: string | null | undefined
): string | null {
  if (!contentType) return null;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return extensions[type] ?? null;
}
