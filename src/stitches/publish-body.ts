/**
 * The body of POST /api/v1/stitches/$id/publish (#2127): the portrait
 * sign-off for a still that shows a real person, or none. Client-safe so the
 * OpenAPI document is generated from the same validator the route runs.
 */

import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { z } from 'zod';

export const publishStitchBodySchema = z.object({
  portraitAttestation: z
    .strictObject({
      statementVersion: z.literal(PORTRAIT_RIGHTS_V1.version),
      authorizationBasis: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          'Basis for the authorization: a release reference, "self", a contract id.'
        ),
    })
    .nullable()
    .default(null),
});
