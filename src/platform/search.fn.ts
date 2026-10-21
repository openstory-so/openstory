import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import {
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
} from '@/platform/search';

/** Everything of the team's that holds `query` (#2100). */
export const searchFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        query: z.string().trim().min(SEARCH_MIN_LENGTH).max(SEARCH_MAX_LENGTH),
      })
    )
  )
  .handler(async ({ context, data }) => {
    return context.scopedDb.search.find(data.query, SEARCH_GROUP_LIMIT);
  });
