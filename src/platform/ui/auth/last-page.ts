/**
 * Last page the visitor was on (#2105).
 *
 * A route guard, gift link, or in-page sign-in dialog already passes
 * `redirectTo`. Sidebar "Sign in" and a bookmarked `/login` do not, so the
 * page is kept here and resumed after sign-in. Bare `/` is the default
 * destination and is not stored: sign-out navigates home, and writing that
 * would erase the page they were actually on.
 */

import { isServerRedirect } from './oauth-login-resume';
import { sanitizeAuthRedirect } from './navigation';

const STORAGE_KEY = 'openstory:last-page';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A page worth returning to. Auth flow, server routes, and bare home are not. */
function isResumePage(path: string): boolean {
  if (path === '/' || isServerRedirect(path)) return false;
  const pathname = path.split('?')[0] ?? path;
  return (
    pathname !== '/login' &&
    !pathname.startsWith('/login/') &&
    pathname !== '/verify' &&
    !pathname.startsWith('/verify/') &&
    pathname !== '/oauth' &&
    !pathname.startsWith('/oauth/')
  );
}

export function rememberLastPage(href: string): void {
  const path = sanitizeAuthRedirect(href);
  if (!isResumePage(path)) return;
  try {
    storage()?.setItem(STORAGE_KEY, path);
  } catch {
    // private mode or quota — sign-in still follows an explicit redirect, or home
  }
}

function readLastPage(): string {
  try {
    const path = sanitizeAuthRedirect(storage()?.getItem(STORAGE_KEY));
    return isResumePage(path) ? path : '/';
  } catch {
    return '/';
  }
}

/**
 * Where sign-in should land.
 *
 * An explicit `redirectTo` wins, including an explicit `/` (the composer
 * dialog must stay on the draft). A bare login resumes localStorage.
 * `hydrated` is false during SSR so the server and the first client render
 * both use `/` until storage can be read.
 */
export function loginRedirect(
  explicit: string | undefined,
  hydrated: boolean
): string {
  if (explicit !== undefined && explicit.trim() !== '') {
    return sanitizeAuthRedirect(explicit);
  }
  if (!hydrated) return '/';
  return readLastPage();
}
