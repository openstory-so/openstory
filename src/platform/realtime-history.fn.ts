import { getChannelHistory } from '@/platform/realtime';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authMiddleware } from './middleware.fn';

const channelInputSchema = z.object({ channel: z.string().min(1) });

/**
 * Fetches the replayable tail of a realtime channel's history (backed by the
 * channel's `RealtimeChannel` Durable Object SQLite storage, bounded by rows
 * and bytes there). Used to replay generation progress state after a page
 * refresh. Each row's `data` is the JSON string the DO stored — passed through
 * verbatim, never parsed and re-serialized here (#1811).
 */
export const getChannelHistoryFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(zodValidator(channelInputSchema))
  .handler(({ data }) => getChannelHistory(data.channel));
