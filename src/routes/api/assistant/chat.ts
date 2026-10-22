/**
 * The in-app assistant's chat endpoint (#2155). POST streams one turn as
 * SSE; GET `?threadId=` hydrates a thread (transcript, paused approvals)
 * and GET `?runId=&offset=` tails a run's log (a reload mid-reply).
 * Session callers only: the MCP server at /mcp is the Bearer-token surface.
 */
import { createFileRoute } from '@tanstack/react-router';
import {
  handleAssistantChat,
  handleAssistantHydrate,
  handleAssistantJoin,
  type AssistantCaller,
} from '@/assistant/server/assistant-chat';
import { handleApiError } from '@/platform/errors';
import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';

type RouteContext = Pick<AssistantCaller, 'user' | 'teamId' | 'scopedDb'>;

async function callerFrom(
  request: Request,
  context: RouteContext
): Promise<AssistantCaller> {
  return {
    scopedDb: context.scopedDb,
    user: context.user,
    teamId: context.teamId,
    teamName: await context.scopedDb.assistant.teamName(),
    origin: new URL(request.url).origin,
    request,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  const handled = handleApiError(error);
  return Response.json(
    { success: false, error: handled.toJSON() },
    { status: handled.statusCode }
  );
}

export const Route = createFileRoute('/api/assistant/chat')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        try {
          return await handleAssistantChat(await callerFrom(request, context));
        } catch (error) {
          return errorResponse(error);
        }
      },
      GET: async ({ request, context }) => {
        try {
          const caller = await callerFrom(request, context);
          if (new URL(request.url).searchParams.has('runId')) {
            return handleAssistantJoin(caller);
          }
          return await handleAssistantHydrate(caller);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
