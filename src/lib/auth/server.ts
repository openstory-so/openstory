/**
 * Session read for TanStack Start.
 *
 * Server-only `createServerFn` — Better Auth + Start's recommended pattern.
 * Call from `beforeLoad` / React Query; the handler runs in-process on SSR
 * and as an RPC on the client. Do not use `authClient.useSession()` for
 * "am I logged in" — that is a second store that refetches on mount.
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { getAuth } from './config';

export const getSessionFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const sessionData = await getAuth().api.getSession({
      headers: getRequestHeaders(),
    });
    return sessionData ?? null;
  }
);
