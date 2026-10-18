import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  createTestCharacter,
  getTestCharacter,
} from '@/platform/server/test/seed';
import { testOnlyGuard } from './route';

const CreateCharacterSchema = z.object({
  sequenceId: z.string(),
  characterId: z.string(),
  name: z.string(),
  sheetImageUrl: z.string().optional(),
  sheetStatus: z
    .enum(['pending', 'generating', 'completed', 'failed'])
    .optional(),
});

export const Route = createFileRoute('/api/test/character')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const body = CreateCharacterSchema.parse(await request.json());

          if (!body.sequenceId || !body.characterId || !body.name) {
            return Response.json(
              { error: 'sequenceId, characterId and name are required' },
              { status: 400 }
            );
          }

          const created = await createTestCharacter(
            body.sequenceId,
            body.characterId,
            body.name,
            {
              sheetImageUrl: body.sheetImageUrl,
              sheetStatus: body.sheetStatus,
            }
          );

          return Response.json(created);
        },

        /**
         * GET /api/test/character?id=... -> single character for assertions/polling
         */
        GET: async ({ request }) => {
          const url = new URL(request.url);
          const id = url.searchParams.get('id');
          if (!id) {
            return Response.json(
              { error: 'id query param required' },
              { status: 400 }
            );
          }
          const ch = await getTestCharacter(id);
          if (!ch) {
            return Response.json({ error: 'not found' }, { status: 404 });
          }
          return Response.json(ch);
        },
      }),
  },
});
