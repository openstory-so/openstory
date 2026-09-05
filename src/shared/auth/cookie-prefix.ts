/**
 * Better Auth cookie prefix.
 *
 * Browsers scope cookies by host, not port, so two `bun dev` worktrees on
 * localhost:3000 and localhost:3001 both send `better-auth.session_token`.
 * Each worktree has its own Miniflare D1, so the session lookup fails (or
 * worse, hits a different user) and logging into one clobbers the other.
 *
 * Dev (`vite serve`) injects a per-cwd prefix via
 * `import.meta.env.VITE_AUTH_COOKIE_PREFIX` (see vite.config.ts). Production
 * builds leave it unset and keep Better Auth's default `better-auth`, so
 * existing sessions survive deploys.
 */

export const DEFAULT_AUTH_COOKIE_PREFIX = 'better-auth';

/**
 * FNV-1a 32-bit as 8 lowercase hex chars.
 * Test vectors: "" → 811c9dc5, "a" → e40c292c, "foobar" → bf9cf968.
 */
function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Cookie prefix unique to this checkout. Safe as a cookie-name token. */
export function worktreeAuthCookiePrefix(cwd: string): string {
  return `ba-${fnv1a32Hex(cwd)}`;
}

/**
 * Resolve the Better Auth `advanced.cookiePrefix`.
 * `injectedPrefix` is Vite's `import.meta.env.VITE_AUTH_COOKIE_PREFIX` from
 * `vite serve`; ignored when `isDev` is false so a leaked env cannot rename
 * production cookies.
 */
export function resolveAuthCookiePrefix(input: {
  isDev: boolean;
  injectedPrefix: string | undefined;
}): string {
  if (input.isDev && input.injectedPrefix) return input.injectedPrefix;
  return DEFAULT_AUTH_COOKIE_PREFIX;
}

/** Prefix for this process: worktree-local in vite dev, default in production. */
export function currentAuthCookiePrefix(): string {
  return resolveAuthCookiePrefix({
    isDev: import.meta.env.DEV,
    injectedPrefix: import.meta.env.VITE_AUTH_COOKIE_PREFIX,
  });
}

/** `lastLoginMethod` cookie; plugin default is `better-auth.last_used_login_method`. */
export function lastUsedLoginMethodCookieName(prefix: string): string {
  return `${prefix}.last_used_login_method`;
}
