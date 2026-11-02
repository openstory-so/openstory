import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { createTestStyle } from '@/platform/server/test/seed';
import { testOnlyGuard } from './route';

const CreateStyleSchema = z.object({
  organizationId: z.string(),
});

export const Route = createFileRoute('/api/test/style')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { organizationId } = CreateStyleSchema.parse(
            await request.json()
          );
          if (!organizationId) {
            return Response.json(
              { error: 'organizationId is required' },
              { status: 400 }
            );
          }

          const style = await createTestStyle(organizationId);
          return Response.json(style);
        },
      }),
  },
});
