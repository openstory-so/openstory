import { realtimeSchema } from '@/platform/realtime/schema';
import type {
  EventPaths,
  EventPayloadUnion,
} from '@/platform/server/realtime/shared-types';
import type { z } from 'zod';

type RealtimePayload = EventPayloadUnion<
  typeof realtimeSchema,
  EventPaths<typeof realtimeSchema>
>;

type RealtimeMessage = {
  event: string;
  channel: string;
  data: unknown;
};

function tryLeaf<const E extends string, S extends z.ZodType>(
  eventName: E,
  schema: S,
  message: RealtimeMessage
): { event: E; channel: string; data: z.infer<S> } | null {
  if (message.event !== eventName) return null;
  const parsed = schema.safeParse(message.data);
  if (!parsed.success) return null;
  return {
    event: eventName,
    channel: message.channel,
    data: parsed.data,
  };
}

/**
 * Parse one wire message into the schema member it names.
 * Unknown event names and payloads that fail the leaf schema are dropped.
 */
function parseRealtimeLeaves(message: RealtimeMessage) {
  return (
    tryLeaf(
      'talent.sheet:progress',
      realtimeSchema.talent['sheet:progress'],
      message
    ) ??
    tryLeaf(
      'location.sheet:progress',
      realtimeSchema.location['sheet:progress'],
      message
    ) ??
    tryLeaf(
      'billing.balance:updated',
      realtimeSchema.billing['balance:updated'],
      message
    ) ??
    tryLeaf(
      'shotPrompt.streaming',
      realtimeSchema.shotPrompt.streaming,
      message
    ) ??
    tryLeaf(
      'shotPrompt.completed',
      realtimeSchema.shotPrompt.completed,
      message
    ) ??
    tryLeaf('shotPrompt.failed', realtimeSchema.shotPrompt.failed, message) ??
    tryLeaf(
      'generation.phase:start',
      realtimeSchema.generation['phase:start'],
      message
    ) ??
    tryLeaf(
      'generation.phase:complete',
      realtimeSchema.generation['phase:complete'],
      message
    ) ??
    tryLeaf(
      'generation.scene:new',
      realtimeSchema.generation['scene:new'],
      message
    ) ??
    tryLeaf(
      'generation.scene:updated',
      realtimeSchema.generation['scene:updated'],
      message
    ) ??
    tryLeaf(
      'generation.shot:created',
      realtimeSchema.generation['shot:created'],
      message
    ) ??
    tryLeaf(
      'generation.shot:updated',
      realtimeSchema.generation['shot:updated'],
      message
    ) ??
    tryLeaf(
      'generation.image:progress',
      realtimeSchema.generation['image:progress'],
      message
    ) ??
    tryLeaf(
      'generation.preview:replaced',
      realtimeSchema.generation['preview:replaced'],
      message
    ) ??
    tryLeaf(
      'generation.variant-image:progress',
      realtimeSchema.generation['variant-image:progress'],
      message
    ) ??
    tryLeaf(
      'generation.video:progress',
      realtimeSchema.generation['video:progress'],
      message
    ) ??
    tryLeaf(
      'generation.audio:progress',
      realtimeSchema.generation['audio:progress'],
      message
    ) ??
    tryLeaf(
      'generation.character-sheet:progress',
      realtimeSchema.generation['character-sheet:progress'],
      message
    ) ??
    tryLeaf(
      'generation.character-voice:progress',
      realtimeSchema.generation['character-voice:progress'],
      message
    ) ??
    tryLeaf(
      'generation.location-sheet:progress',
      realtimeSchema.generation['location-sheet:progress'],
      message
    ) ??
    tryLeaf(
      'generation.recast:start',
      realtimeSchema.generation['recast:start'],
      message
    ) ??
    tryLeaf(
      'generation.recast:complete',
      realtimeSchema.generation['recast:complete'],
      message
    ) ??
    tryLeaf(
      'generation.recast:failed',
      realtimeSchema.generation['recast:failed'],
      message
    ) ??
    tryLeaf(
      'generation.recast-location:start',
      realtimeSchema.generation['recast-location:start'],
      message
    ) ??
    tryLeaf(
      'generation.recast-location:complete',
      realtimeSchema.generation['recast-location:complete'],
      message
    ) ??
    tryLeaf(
      'generation.recast-location:failed',
      realtimeSchema.generation['recast-location:failed'],
      message
    ) ??
    tryLeaf(
      'generation.replace-element:start',
      realtimeSchema.generation['replace-element:start'],
      message
    ) ??
    tryLeaf(
      'generation.replace-element:complete',
      realtimeSchema.generation['replace-element:complete'],
      message
    ) ??
    tryLeaf(
      'generation.replace-element:failed',
      realtimeSchema.generation['replace-element:failed'],
      message
    ) ??
    tryLeaf(
      'generation.location:matched',
      realtimeSchema.generation['location:matched'],
      message
    ) ??
    tryLeaf(
      'generation.talent:matched',
      realtimeSchema.generation['talent:matched'],
      message
    ) ??
    tryLeaf(
      'generation.talent:unmatched',
      realtimeSchema.generation['talent:unmatched'],
      message
    ) ??
    tryLeaf(
      'generation.poster:ready',
      realtimeSchema.generation['poster:ready'],
      message
    ) ??
    tryLeaf(
      'generation.style:ready',
      realtimeSchema.generation['style:ready'],
      message
    ) ??
    tryLeaf(
      'generation.stale:detected',
      realtimeSchema.generation['stale:detected'],
      message
    ) ??
    tryLeaf('generation.updated', realtimeSchema.generation.updated, message) ??
    tryLeaf('generation.failed', realtimeSchema.generation.failed, message) ??
    tryLeaf(
      'generation.reservation:short',
      realtimeSchema.generation['reservation:short'],
      message
    ) ??
    tryLeaf(
      'generation.complete',
      realtimeSchema.generation.complete,
      message
    ) ??
    tryLeaf('generation.error', realtimeSchema.generation.error, message)
  );
}

type HandledRealtimeEvent = NonNullable<
  ReturnType<typeof parseRealtimeLeaves>
>['event'];

type MissingRealtimeEvent = Exclude<
  EventPaths<typeof realtimeSchema>,
  HandledRealtimeEvent
>;

/** Compile-time check that every schema path is parsed above. */
export const everyRealtimeEventIsParsed: [MissingRealtimeEvent] extends [never]
  ? true
  : never = true;

export function parseRealtimeUserEvent(
  message: RealtimeMessage
): RealtimePayload | null {
  return parseRealtimeLeaves(message);
}

export function isSelectedRealtimeEvent<
  E extends EventPaths<typeof realtimeSchema>,
>(
  payload: RealtimePayload,
  events: readonly E[]
): payload is EventPayloadUnion<typeof realtimeSchema, E> {
  return events.some((eventName) => eventName === payload.event);
}
