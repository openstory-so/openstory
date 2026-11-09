import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';

const SLUGGED_KINDS = ['sequence', 'character', 'location'] as const;
export type SluggedKind = (typeof SLUGGED_KINDS)[number];

/** The ULID a route's slug names in the organization, or null (#2222). */
export const resolveSlugFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(
      z.object({
        kind: z.enum(SLUGGED_KINDS),
        slug: z.string().min(1).max(200),
      })
    )
  )
  .handler(async ({ context: { scopedDb }, data }) => {
    const modules = {
      sequence: scopedDb.sequences,
      character: scopedDb.characters,
      location: scopedDb.locations,
    };
    return modules[data.kind].resolveId(data.slug);
  });
