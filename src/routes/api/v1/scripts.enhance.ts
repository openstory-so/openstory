/**
 * POST /api/v1/scripts/enhance — public, streaming script enhancement.
 *
 * Enhances a script WITHOUT creating a sequence: takes the enhancement-relevant
 * inputs (style, aspect ratio, target duration, reference elements) and streams
 * the enhanced script back as Server-Sent Events (unnamed `data:` delta shots,
 * then a terminal `event: done` carrying the full text plus the HAL `_links`
 * catalog of next actions — notably `create-sequence` pre-filled with the
 * enhanced script).
 *
 * Authenticated via `authWithTeamRequestMiddleware` (API key or dashboard
 * session), billed per request like the dashboard enhance. Pre-stream failures
 * (bad body, unresolvable style, billing) return the standard JSON error
 * envelope; failures after streaming has begun arrive as an `event: error` shot.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import {
  buildEnhanceGenerator,
  enhanceSseResponse,
} from '@/lib/api-v1/enhance';
import { apiEnhanceScriptSchema } from '@/lib/api-v1/enhance-input-schema';
import { DEFAULT_VIDEO_MODEL, isValidImageToVideoModel } from '@/lib/ai/models';
import { apiJsonError, runApiV1Handler } from '@/lib/api-v1/errors';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/scripts/enhance')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      POST: async ({ request, context }) =>
        runApiV1Handler(async () => {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return apiJsonError(
              400,
              'INVALID_JSON',
              'Request body must be valid JSON.'
            );
          }

          const input = apiEnhanceScriptSchema.parse(body);
          const gen = await buildEnhanceGenerator(input, {
            scopedDb: context.scopedDb,
            user: context.user,
            teamId: context.teamId,
          });

          // Pull the first chunk here (inside runApiV1Handler) so setup failures
          // — billing, the LLM call — surface as a JSON error with the right
          // status before any SSE headers are committed.
          const first = await gen.next();
          return enhanceSseResponse(first, gen, {
            targetSeconds: input.targetSeconds ?? 30,
            videoModel:
              input.videoModel && isValidImageToVideoModel(input.videoModel)
                ? input.videoModel
                : DEFAULT_VIDEO_MODEL,
          });
        }),
    },
  },
});
