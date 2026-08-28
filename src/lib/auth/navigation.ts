/**
 * Authentication Navigation Utilities
 * Helpers for navigating to auth pages with redirect preservation
 */

/**
 * Get the redirect URL from query params
 * For use in auth pages to read the intended destination
 * @param searchParams - URLSearchParams or query params object
 * @returns Redirect path or default (`/`, the app home)
 */
export function getRedirectFromParams(
  searchParams: URLSearchParams | Record<string, string | string[] | undefined>
): string {
  let redirectTo: string | null = null;

  if (searchParams instanceof URLSearchParams) {
    redirectTo = searchParams.get('redirectTo');
  } else if (typeof searchParams === 'object' && searchParams.redirectTo) {
    const value = searchParams.redirectTo;
    redirectTo = Array.isArray(value) ? (value[0] ?? null) : value;
  }

  return sanitizeAuthRedirect(redirectTo);
}

/**
 * Safe in-app path for post-login navigation / OAuth `callbackURL`.
 *
 * Better Auth rejects relative callbackURLs that include a hash fragment
 * (`INVALID_CALLBACK_URL` → 403). Gallery "Try this style" links land on
 * `/?style=<slug>#compose` — path + search seed the composer; `#compose` is
 * only a scroll target and must not go to Google as the callback.
 *
 * Also reduces absolute URLs to path + search (origin discarded; only relative
 * `/…` paths are kept) and blocks open redirects (never `/login…`).
 */
export function sanitizeAuthRedirect(
  redirectTo: string | null | undefined
): string {
  if (!redirectTo) return '/';

  let path = redirectTo.trim();
  if (!path) return '/';

  // Absolute URL → path + search only (drop origin and hash).
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = `${url.pathname}${url.search}`;
    } catch {
      return '/';
    }
  }

  // Drop hash (#compose and friends) — better-auth's relative-path allowlist
  // does not accept `#`.
  const hashIdx = path.indexOf('#');
  if (hashIdx >= 0) {
    path = path.slice(0, hashIdx);
  }

  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  if (path.startsWith('/login')) return '/';

  return path || '/';
}
