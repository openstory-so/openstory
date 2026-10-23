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
  .handler(async ({ context, data }) => ({
    deleted: await context.scopedDb.assistant.deleteThread(data.threadId),
  }));
