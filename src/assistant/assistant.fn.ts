/**
 * The assistant's threads (#2155): list, rename, delete. Messages go over
 * /api/assistant/chat, which streams; these are the small reads and writes
 * around them.
 */
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { getRequest } from '@tanstack/react-start/server';
import { OpenStoryError } from '@/platform/errors';
import { SEQUENCE_CARD_URI, VIEW_CALLABLE_TOOLS } from '@/platform/mcp-views';
import { MCP_TOOLS } from '@/platform/server/mcp/server';
import { SEQUENCE_CARD_HTML } from '@/platform/server/mcp/ui/sequence-card';
import { deleteStreamLogs } from './server/durability';
import { toolContext, type AssistantCaller } from './server/assistant-chat';

const threadIdSchema = z.object({ threadId: ulidSchema });

export const listAssistantThreadsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const threads = await context.scopedDb.assistant.listThreads();
    return threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt.toISOString(),
    }));
  });

export const renameAssistantThreadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      threadIdSchema.extend({ title: z.string().trim().min(1).max(80) })
    )
  )
  .handler(async ({ context, data }) => {
    await context.scopedDb.assistant.renameThread(data.threadId, data.title);
  });

export const deleteAssistantThreadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(threadIdSchema))
  .handler(async ({ context, data }) => {
    const runIds = await context.scopedDb.assistant.deleteThread(data.threadId);
    if (runIds === null) return { deleted: false };
    // The rows are gone; the replies' stream logs go with them.
    await deleteStreamLogs(context, runIds);
    return { deleted: true };
  });

/**
 * A tool's MCP Apps view (#1673) for the in-app host (#2155): the same page
 * the MCP server serves as a `ui://` resource, by its URI.
 */
export const getMcpViewFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ uri: z.string().min(1).max(200) })))
  .handler(({ data }) => {
    if (data.uri !== SEQUENCE_CARD_URI) {
      throw new OpenStoryError('No such view', 'NOT_FOUND', 404);
    }
    return { html: SEQUENCE_CARD_HTML };
  });

/**
 * `tools/call` from a view: one of `VIEW_CALLABLE_TOOLS`, under the session, with
 * the MCP envelope kept so the page reads `structuredContent` as it would
 * from any host. Anything else is refused: a view never spends, changes or roams.
 */
export const callMcpReadToolFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        name: z.string().min(1).max(100),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === data.name);
    if (!tool || !VIEW_CALLABLE_TOOLS.has(tool.name) || !tool.execute) {
      throw new OpenStoryError(
        'A view may only call the tools its page needs',
        'FORBIDDEN',
        403
      );
    }
    const request = getRequest();
    const caller: AssistantCaller = {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
      teamName: await context.scopedDb.assistant.teamName(),
      origin: new URL(request.url).origin,
      request,
    };
    return tool.execute(data.arguments, { context: toolContext(caller) });
  });
