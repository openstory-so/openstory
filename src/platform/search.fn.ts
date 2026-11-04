import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';
import {
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
} from '@/platform/search';

/** Everything of the organization's that holds `query` (#2100). */
export const searchFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
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
