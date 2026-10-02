import { getEnv } from '#env';
import { z } from 'zod';

import { getLogger } from '@/platform/logger';
import type { ChannelHistoryMessage } from '@/platform/server/realtime/realtime-channel.do';
import type {
  EventData,
  EventPaths,
} from '@/platform/server/realtime/shared-types';

import { realtimeSchema, sheetProgressActivitySchema } from './schema';
export { realtimeSchema, sheetProgressActivitySchema };
export type { SheetProgressActivity } from './schema';

const logger = getLogger(['openstory', 'realtime', 'index']);

/**
 * Inferred payload type for `generation.stale:detected`. Exported so client
 * hooks bind to the discriminated union directly instead of redeclaring the
 * payload locally — local redeclarations widen `entityType` back to `string`
 * and defeat the schema's branch narrowing.
 */
export type StaleDetectedPayload = z.infer<
  (typeof realtimeSchema.generation)['stale:detected']
>;

export type ReplaceElementStartPayload = z.infer<
  (typeof realtimeSchema.generation)['replace-element:start']
>;
export type ReplaceElementCompletePayload = z.infer<
  (typeof realtimeSchema.generation)['replace-element:complete']
>;
export type ReplaceElementFailedPayload = z.infer<
  (typeof realtimeSchema.generation)['replace-element:failed']
>;

export type BalanceUpdatedPayload = z.infer<
  (typeof realtimeSchema.billing)['balance:updated']
>;

/** Every dotted event path declared in `realtimeSchema`. */
type SchemaEventPath = EventPaths<typeof realtimeSchema>;

/** The inferred payload type for a given event path. */
type SchemaEventData<K extends SchemaEventPath> =
  EventData<typeof realtimeSchema, K> extends z.ZodType
    ? z.infer<EventData<typeof realtimeSchema, K>>
    : never;

/**
 * Server-side channel API, backed by the `RealtimeChannel` Durable Object
 * (#802). `emit` keeps the same typed signature the call sites used under
 * Upstash; `history` reads the DO's persisted events for replay.
 */
type RealtimeChannelApi = {
  emit: <K extends SchemaEventPath>(
    event: K,
    data: SchemaEventData<K>
  ) => Promise<void>;
  history: () => Promise<ChannelHistoryMessage[]>;
};

/**
 * Events that are only useful live. They are broadcast but never written to
 * the channel's history (#1811).
 */
const TRANSIENT_EVENTS: ReadonlySet<SchemaEventPath> = new Set([
  'shotPrompt.streaming',
]);

/** Resolve the Durable Object stub for a channel id. */
function channelStub(channel: string) {
  // getEnv()'s type is platform-dependent; the Cloudflare runtime guarantees
  // the Cloudflare.Env shape with the REALTIME Durable Object binding present.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- platform-dependent env shape
  const namespace = (getEnv() as unknown as Cloudflare.Env).REALTIME;
  return namespace.get(namespace.idFromName(channel));
}

/** Build the DO-backed channel API for a concrete channel id. */
function realtimeChannel(channel: string): RealtimeChannelApi {
  return {
    async emit(event, data) {
      try {
        const response = await channelStub(channel).fetch(
          `https://realtime.do/emit?channel=${encodeURIComponent(channel)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              event,
              data,
              transient: TRANSIENT_EVENTS.has(event) || undefined,
            }),
          }
        );
        if (!response.ok) {
          logger.warn(`realtime emit failed for "${channel}"`, {
            status: response.status,
            event,
          });
        }
      } catch (error) {
        // A realtime emit is best-effort progress signalling — never let a
        // broker hiccup fail the workflow step that produced the real artifact.
        logger.warn(`realtime emit threw for "${channel}"`, {
          err: error,
          event,
        });
      }
    },
    async history() {
      const response = await channelStub(channel).fetch(
        `https://realtime.do/history?channel=${encodeURIComponent(channel)}`
      );
      if (!response.ok) {
        logger.warn(`realtime history fetch failed for "${channel}"`, {
          status: response.status,
        });
        return [];
      }
      return response.json<ChannelHistoryMessage[]>();
    },
  };
}

/**
 * Build a no-op channel stub when an id is missing. Logs a warning so a
 * dropped emit is observable in production rather than silently lost — the
 * channel-id helpers below are server-only, and a missing id is always a
 * bug at the call site.
 */
function noopChannel(label: string): RealtimeChannelApi {
  logger.warn(
    `dropping ${label} emit: missing channel id — caller should guard on id presence before emitting`
  );
  return {
    emit: () => Promise.resolve(),
    history: () => Promise.resolve([]),
  };
}

/**
 * Read a channel's persisted event history for replay (page refresh
 * resilience). Backed by the channel's Durable Object SQLite storage.
 */
export function getChannelHistory(
  channel: string
): Promise<ChannelHistoryMessage[]> {
  return realtimeChannel(channel).history();
}

/**
 * Get a channel for a specific sequence to emit/receive events.
 * @param sequenceId - The sequence ID to use as the channel identifier
 */
export function getGenerationChannel(sequenceId?: string): RealtimeChannelApi {
  return sequenceId ? realtimeChannel(sequenceId) : noopChannel('generation');
}

/**
 * Get a channel for talent library events.
 * @param talentId - The talent ID to use as the channel identifier
 */
export function getTalentChannel(talentId?: string): RealtimeChannelApi {
  return talentId
    ? realtimeChannel(`talent:${talentId}`)
    : noopChannel('talent');
}

/**
 * Get a channel for location library events.
 * @param locationId - The location ID to use as the channel identifier
 */
export function getLocationChannel(locationId?: string): RealtimeChannelApi {
  return locationId
    ? realtimeChannel(`location:${locationId}`)
    : noopChannel('location');
}

/**
 * Get a channel for per-shot prompt regeneration streaming.
 * @param shotId - The shot ID to use as the channel identifier
 */
export function getShotPromptChannel(shotId?: string): RealtimeChannelApi {
  return shotId
    ? realtimeChannel(`shot-prompt:${shotId}`)
    : noopChannel('shot-prompt');
}

/**
 * Team-scoped billing channel for live credit-balance updates (#1090).
 * Channel id: `billing:${teamId}`.
 */
export function getBillingChannel(teamId?: string): RealtimeChannelApi {
  return teamId ? realtimeChannel(`billing:${teamId}`) : noopChannel('billing');
}

/** Stable channel id for a team's billing events (client subscribe + history). */
export function billingChannelId(teamId: string): string {
  return `billing:${teamId}`;
}
