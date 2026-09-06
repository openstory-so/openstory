/**
 * Shared query options for the anonymous public style catalogue.
 *
 * Kept out of `use-styles.ts` so the `/` loader / `_app` beforeLoad can
 * prefetch without pulling the recommend-styles LLM module into the
 * layout's critical path.
 */
import { getPublicStylesFn } from '@/functions/public-styles';
import { queryOptions } from '@tanstack/react-query';

export const publicStylesQueryKey = ['styles', 'list', 'public'] as const;

export const publicStylesQueryOptions = queryOptions({
  queryKey: publicStylesQueryKey,
  queryFn: () => getPublicStylesFn(),
  staleTime: 10 * 60 * 1000,
});
