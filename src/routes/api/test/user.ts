import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { cleanupTestUser, createTestUser } from '@/platform/server/test/seed';
import { testOnlyGuard } from './route';

const DeleteUserSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
});

export const Route = createFileRoute('/api/test/user')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        /**
         * POST /api/test/user
         */
        POST: async ({ request }) => {
          let body: { name?: string; admin?: boolean } = {};
          try {
            body = await request.json();
          } catch {
            // ok, use defaults
          }

          const created = await createTestUser({
            name: body.name,
            admin: body.admin === true,
          });
          return Response.json(created);
        },

        /**
         * DELETE /api/test/user
         */
        DELETE: async ({ request }) => {
          const { userId, organizationId } = DeleteUserSchema.parse(
            await request.json()
          );

          if (!userId || !organizationId) {
            return Response.json(
              { error: 'userId and organizationId are required' },
              { status: 400 }
            );
          }

          try {
            await cleanupTestUser(userId, organizationId);
          } catch (error) {
            // The failing query and its D1 cause, for the e2e log.
            return Response.json(
              {
                error: String(error),
                cause: error instanceof Error ? String(error.cause) : undefined,
              },
              { status: 500 }
            );
          }
          return Response.json({ success: true });
        },
      }),
  },
});
