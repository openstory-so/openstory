import { getChannelHistory } from '@/lib/realtime';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'realtime-history']);

const channelInputSchema = z.object({ channel: z.string().min(1) });

/**
 * Fetches all events from a realtime channel's history (backed by the
 * channel's `RealtimeChannel` Durable Object SQLite storage). Used to replay
 * generation progress state after a page refresh.
 */
export const getChannelHistoryFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(zodValidator(channelInputSchema))
  .handler(async ({ data }) => {
    const messages = await getChannelHistory(data.channel);

    // The DO stores each event's `data` as a JSON string. Normalize to an
    // object and re-stringify for transport (TanStack Start server functions
    // reject `unknown` in return types), and drop any unparseable row.
    return messages.flatMap((msg) => {
      try {
        const normalizedData =
          typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        return [
          {
            id: msg.id,
            event: msg.event,
            channel: msg.channel,
            data: JSON.stringify(normalizedData),
            ts: msg.ts,
          },
        ];
      } catch {
        logger.error(
          `Failed to parse message ${msg.id} in channel "${data.channel}"`,
          { data: msg.data }
        );
        return [];
      }
    });
  });
