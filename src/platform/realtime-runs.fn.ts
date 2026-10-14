import { getChannelRuns } from '@/platform/server/realtime/runs';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authMiddleware } from './middleware.fn';

const channelInputSchema = z.object({ channel: z.string().min(1) });

/**
 * Open workflow runs on a sequence channel (#2113). Read after the SSE
 * stream connects so a run that started during page load is not missed.
 * Start and end events then keep the list current; they are not in history.
 */
export const getChannelRunsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(zodValidator(channelInputSchema))
  .handler(({ data }) => getChannelRuns(data.channel));
