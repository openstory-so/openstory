import { z } from 'zod';

/**
 * A stored or displayable media URL.
 *
 * Stored media URLs are origin-relative (`/r2/<bucket>/<path>`, served by the
 * worker's /r2 route — see #894), and derived display URLs can be relative
 * too (`/cdn-cgi/image/...`). Legacy rows and external sources (fal CDN
 * outputs, user-supplied references) are absolute http(s) URLs. `z.url()`
 * would reject the relative form, so every validator that handles our media
 * URLs uses this instead.
 *
 * Protocol-relative `//host/...` is rejected: browsers resolve it
 * cross-origin (`<img src>`, `new URL(url, origin)`), so accepting it would
 * let a user-supplied "path" smuggle in a foreign host.
 *
 * A `.` or `..` segment, an encoded dot, a backslash, a query, a fragment,
 * a control character or whitespace is rejected too (#2153, #2192). A storage key is matched by prefix; anything that
 * later resolves the URL (a CDN fetch) can land on a different object.
 */
export function mediaUrlHasTraversal(value: string): boolean {
  if (/[\\?#]/.test(value) || /%2e/i.test(value)) return true;
  // The URL parser strips tabs and newlines, so `.<tab>.` becomes `..` once
  // fetched: refuse every control character and whitespace (#2192).
  // oxlint-disable-next-line no-control-regex -- matching them is the point
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return true;
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return true;
    }
  }
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

export const mediaUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      ((value.startsWith('/') && !value.startsWith('//')) ||
        /^https?:\/\//.test(value)) &&
      !mediaUrlHasTraversal(value),
    {
      message: 'Must be an absolute http(s) URL or an origin-relative path',
    }
  );
