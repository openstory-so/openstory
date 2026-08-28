/**
 * Anonymous public style catalogue. Kept out of `styles.ts` so the `/`
 * loader can prefetch without pulling auth middleware into the route
 * server entry (#1182).
 */
import { listPublicStyles } from '@/lib/db/scoped';
import { createServerFn } from '@tanstack/react-start';

/**
 * List publicly-shared styles. No authentication required so anonymous
 * visitors can browse and pick a style while composing a sequence before
 * being prompted to sign in.
 */
export const getPublicStylesFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    return listPublicStyles();
  }
);
