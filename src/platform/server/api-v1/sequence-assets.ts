/**
 * OpenAPI document for `GET /api/v1/sequences/{id}/assets` (#2209).
 * The asset list itself lives in `@/sequences/sequence-assets` so the page
 * can use it. `.meta` is on this schema, the one the route returns, because
 * `.extend()` would drop it from a parent.
 */
import { sequenceAssetsBodySchema } from '@/sequences/sequence-assets';
import { halLinksSchema } from './hal';

export const sequenceAssetsResultSchema = sequenceAssetsBodySchema
  .extend({ _links: halLinksSchema })
  .meta({ id: 'SequenceAssetsResult' });
