/**
 * Resume an OAuth authorize request after login (#1456).
 *
 * When `/api/auth/oauth2/authorize` finds no session it redirects to the
 * configured `loginPage` with the client's authorization query *signed*
 * (`sig`, `exp`, `ba_iat`, `ba_pl`). The plugin's own continuation expects the
 * login page to echo that signed query back on every sign-in call. Our login
 * form is shared with the rest of the app and knows nothing about OAuth, so
 * instead `/oauth/login` (a server route) converts the signed query into an
 * ordinary `redirectTo`: after sign-in the browser is sent straight back to
 * `/oauth2/authorize` with the client's original parameters, which is exactly
 * what a client whose user was already signed in would have hit.
 */

/** Params the provider adds when it signs the query; never replayed. */
const SIGNED_QUERY_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl'] as const;

const OAUTH_AUTHORIZE_PATH = '/api/auth/oauth2/authorize';

/**
 * `/api/auth/oauth2/authorize?…` with the client's original parameters, or
 * `null` when the query isn't an authorization request (no `client_id`).
 *
 * `prompt=login` is dropped: the user is about to log in, and leaving it
 * would send them straight back here.
 */
export function buildAuthorizeResumePath(
  search: URLSearchParams
): string | null {
  if (!search.get('client_id')) return null;

  const params = new URLSearchParams(search);
  for (const key of SIGNED_QUERY_PARAMS) params.delete(key);

  const prompt = params.get('prompt');
  if (prompt !== null) {
    const kept = prompt
      .split(' ')
      .filter((value) => value && value !== 'login');
    if (kept.length > 0) params.set('prompt', kept.join(' '));
    else params.delete('prompt');
  }

  return `${OAUTH_AUTHORIZE_PATH}?${params.toString()}`;
}

/** `/login?redirectTo=…` for the given signed authorize query. */
export function buildLoginRedirect(search: URLSearchParams): string {
  const resume = buildAuthorizeResumePath(search);
  if (!resume) return '/login';
  return `/login?redirectTo=${encodeURIComponent(resume)}`;
}

/**
 * Post-login destinations under `/api/` are server routes, not app routes —
 * the OAuth resume above is the one case today. TanStack's client-side
 * `navigate` would 404 on them; they need a full navigation.
 */
export function isServerRedirect(path: string): boolean {
  return path.startsWith('/api/');
}
