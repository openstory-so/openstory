import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  createScarlettTestCharacter,
  createTestCharacter,
  getTestCharacter,
} from '@/platform/server/test/seed';
import { testOnlyGuard } from './route';

// `preset` makes the team character the full-sequence e2e casts.
const CreateCharacterSchema = z.union([
  z.object({
    sequenceId: z.string(),
    characterId: z.string(),
    name: z.string(),
    sheetImageUrl: z.string().optional(),
    sheetStatus: z
      .enum(['pending', 'generating', 'completed', 'failed'])
      .optional(),
  }),
  z.object({ teamId: z.string().min(1), preset: z.literal('scarlett') }),
]);

export const Route = createFileRoute('/api/test/character')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const body = CreateCharacterSchema.parse(await request.json());
          if ('preset' in body) {
            return Response.json(
              await createScarlettTestCharacter(body.teamId)
            );
          }

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
