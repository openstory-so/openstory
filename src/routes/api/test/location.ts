import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  cleanupLocationById,
  cleanupLocationByName,
  cleanupTestLocations,
  createSunlitLoftTestLocation,
  createTestLocation,
} from '@/platform/server/test/seed';
import { testOnlyGuard } from './route';

// `preset` makes the organization location the full-sequence e2e picks.
const CreateLocationSchema = z.union([
  z.object({ organizationId: z.string().min(1), name: z.string().min(1) }),
  z.object({
    organizationId: z.string().min(1),
    preset: z.literal('sunlit-loft'),
  }),
]);

const DeleteLocationSchema = z.object({
  organizationId: z.string().optional(),
  locationId: z.string().optional(),
  name: z.string().optional(),
});

export const Route = createFileRoute('/api/test/location')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const body = CreateLocationSchema.parse(await request.json());
          const created =
            'preset' in body
              ? await createSunlitLoftTestLocation(body.organizationId)
              : await createTestLocation(body.organizationId, body.name);
          return Response.json(created);
        },

        /**
         * DELETE /api/test/location
         * Supports: {organizationId} (all for organization), {locationId}, or {organizationId, name}
         */
        DELETE: async ({ request }) => {
          const body = DeleteLocationSchema.parse(await request.json());

          if (body.organizationId && !body.name && !body.locationId) {
            await cleanupTestLocations(body.organizationId);
          } else if (body.locationId) {
            await cleanupLocationById(body.locationId);
          } else if (body.organizationId && body.name) {
            await cleanupLocationByName(body.organizationId, body.name);
          } else {
            return Response.json(
              {
                error:
                  'organizationId (for all) or locationId or (organizationId + name) required',
              },
              { status: 400 }
            );
          }

          return Response.json({ success: true });
        },
      }),
  },
});
