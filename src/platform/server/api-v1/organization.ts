/**
 * `GET /api/v1/organization`: the organization a key belongs to (#2222).
 * `personal` marks the user's sign-up organization, which `openstory sync`
 * mirrors as `personal/`.
 */
import { z } from 'zod';
import { halLinksSchema } from './hal';

export const organizationResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    personal: z.boolean(),
    _links: halLinksSchema,
  })
  .meta({ id: 'OrganizationResult' });
