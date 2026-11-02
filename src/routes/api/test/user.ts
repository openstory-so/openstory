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
          let body: { name?: string } = {};
          try {
            body = await request.json();
          } catch {
            // ok, use defaults
          }

          const created = await createTestUser({ name: body.name });
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

          await cleanupTestUser(userId, organizationId);
          return Response.json({ success: true });
        },
      }),
  },
});
