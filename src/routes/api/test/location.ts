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

// `preset` makes the team location the full-sequence e2e picks.
const CreateLocationSchema = z.union([
  z.object({ teamId: z.string().min(1), name: z.string().min(1) }),
  z.object({ teamId: z.string().min(1), preset: z.literal('sunlit-loft') }),
]);

const DeleteLocationSchema = z.object({
  teamId: z.string().optional(),
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
              ? await createSunlitLoftTestLocation(body.teamId)
              : await createTestLocation(body.teamId, body.name);
          return Response.json(created);
        },

        /**
         * DELETE /api/test/location
         * Supports: {teamId} (all for team), {locationId}, or {teamId, name}
         */
        DELETE: async ({ request }) => {
          const body = DeleteLocationSchema.parse(await request.json());

          if (body.teamId && !body.name && !body.locationId) {
            await cleanupTestLocations(body.teamId);
          } else if (body.locationId) {
            await cleanupLocationById(body.locationId);
          } else if (body.teamId && body.name) {
            await cleanupLocationByName(body.teamId, body.name);
          } else {
            return Response.json(
              {
                error:
                  'teamId (for all) or locationId or (teamId + name) required',
              },
              { status: 400 }
            );
          }

          return Response.json({ success: true });
        },
      }),
  },
});
