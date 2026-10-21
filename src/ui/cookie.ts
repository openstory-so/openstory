/**
 * Read and write a plain preference cookie from a route's `beforeLoad`, which
 * runs on the server for the first paint and in the browser after. Values are
 * URI-encoded on both sides, matching h3's cookie serializer.
 */
import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie, setCookie } from '@tanstack/react-start/server';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export const readCookie = createIsomorphicFn()
  .server((name: string): string | undefined => getCookie(name))
  .client((name: string): string | undefined => {
    const prefix = `${name}=`;
    const hit = document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith(prefix));
    return hit ? decodeURIComponent(hit.slice(prefix.length)) : undefined;
  });

export const writeCookie = createIsomorphicFn()
  .server((name: string, value: string) =>
    setCookie(name, value, {
      path: '/',
      maxAge: ONE_YEAR_SECONDS,
      sameSite: 'lax',
    })
  )
  .client((name: string, value: string) => {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
  });
