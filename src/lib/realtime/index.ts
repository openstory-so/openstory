import { getEnv } from '#env';
import { z } from 'zod';

import { getLogger } from '@/lib/observability/logger';
import { sheetProgressActivitySchema } from '@/lib/talent/sheet-progress-copy';
import type { ChannelHistoryMessage } from './realtime-channel.do';
import type { EventData, EventPaths } from './shared-types';

const logger = getLogger(['openstory', 'realtime', 'index']);

/**
 * Realtime event schema for generation progress streaming.
 *
 * Events are organized by category:
 * - generation.* - Events for the overall generation process
 */
export const realtimeSchema = {
  // Talent library events
  talent: {
    // Sheet generation progress
    'sheet:progress': z.object({
      talentId: z.string(),
      status: z.enum(['generating', 'sheet_ready', 'completed', 'failed']),
      /** What the run is actually doing. Omitted on older events → sheet. */
      activity: sheetProgressActivitySchema.optional(),
      sheetId: z.string().optional(),
      sheetImageUrl: z.string().optional(),
      headshotImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),
  },

  // Location library events
  location: {
    'sheet:progress': z.object({
      locationId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      sheetImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),
  },

  // Team billing ledger updates (#1090). Channel `billing:${teamId}`; the
  // credit-balance pill subscribes only while visible so idle sessions pay no
  // SSE cost. Payload is enough to patch the pill optimistically; clients also
  // invalidate the balance + transactions queries.
  billing: {
    'balance:updated': z.object({
      teamId: z.string(),
      /** Post-mutation balance in USD. */
      balanceUsd: z.number(),
      /** Signed ledger amount in USD (negative for usage, positive for top-ups). */
      amountUsd: z.number(),
      transactionId: z.string(),
      type: z.enum([
        'credit_purchase',
        'credit_usage',
        'credit_refund',
        'credit_adjustment',
      ]),
    }),
  },

  // Per-shot prompt regeneration events. Lives on its own channel
  // (`shot-prompt:${shotId}`) so a client only pays the realtime cost while
  // it's actually viewing the shot, and history replay rebuilds the
  // streaming-text state for the active prompt type if the user navigates
  // away and back mid-generation. The `delta` carries the incremental visible
  // characters of the `fullPrompt` field — extraction happens server-side via
  // `extractStreamingStringField` so the client doesn't have to parse partial
  // JSON.
  shotPrompt: {
    streaming: z.object({
      promptType: z.enum(['visual', 'motion']),
      delta: z.string(),
    }),
    completed: z.object({
      promptType: z.enum(['visual', 'motion']),
    }),
    failed: z.object({
      promptType: z.enum(['visual', 'motion']),
      error: z.string(),
    }),
  },

  generation: {
    // Phase lifecycle events
    'phase:start': z.object({
      phase: z.number(),
      phaseName: z.string(),
    }),
    'phase:complete': z.object({
      phase: z.number(),
    }),

    // Scene events (progressive display during analysis)
    'scene:new': z.object({
      sceneId: z.string(),
      sceneNumber: z.number(),
      title: z.string(),
      scriptExtract: z.string(),
      durationSeconds: z.number(),
    }),

    // Scene updated (progressive title correction during streaming)
    'scene:updated': z.object({
      sceneId: z.string(),
      sceneNumber: z.number(),
      title: z.string(),
      scriptExtract: z.string(),
      durationSeconds: z.number(),
    }),

    // Shot events (after DB write)
    'shot:created': z.object({
      shotId: z.string(),
      sceneId: z.string(),
      orderIndex: z.number(),
    }),

    // Shot updated with prompts (visual, motion, audio)
    'shot:updated': z.object({
      shotId: z.string(),
      updateType: z.enum([
        'visual-prompt',
        'motion-prompt',
        'audio-design',
        'music-design',
      ]),
      metadata: z.unknown(), // Full Scene object with prompts
    }),

    // Image generation progress
    'image:progress': z.object({
      shotId: z.string(),
      status: z
        .enum(['pending', 'generating', 'completed', 'failed'])
        .optional(),
      thumbnailUrl: z.string().optional(),
      previewThumbnailUrl: z.string().optional(),
      model: z.string().optional(),
      // In-flight retry state (#882). Emitted before a retry attempt while
      // `status` stays `generating`, so the player overlay can show
      // "Retrying (attempt/maxAttempts)…" instead of an indistinguishable
      // hung spinner. Absent on the first attempt and on terminal events.
      phase: z.enum(['generating', 'retrying']).optional(),
      attempt: z.number().int().positive().optional(),
      maxAttempts: z.number().int().positive().optional(),
      // Variant-only (#547): this update belongs to an added (alternate) model,
      // not the live primary. The cache updater must NOT write it onto the
      // primary `thumbnailUrl`/`thumbnailStatus` — it only refreshes the
      // per-model variant/model-list queries so the new model surfaces in the
      // dropdown without clobbering the displayed primary thumbnail.
      variantOnly: z.boolean().optional(),
      // Failure reason (e.g. content-filter rejection). Carried on `failed`
      // so the cache updater can write `shots.thumbnailError` live — without
      // it the FailureSummaryBanner only ever shows "Unknown error" until a
      // full refetch (#881).
      error: z.string().optional(),
      // Set when this run just appended a `softened` prompt version (#1272).
      // Invalidates visual history and toasts so the user knows the original
      // is still in Versions.
      promptSoftened: z.boolean().optional(),
      // Set when this run swapped to Grok Imagine 2 after the selected model
      // content-flagged (#1272). Invalidates the per-model variant list so the
      // fallback still shows up, and toasts the swap.
      modelFallback: z.boolean().optional(),
    }),

    // Fast preview shots replaced by AI-analyzed shots
    'preview:replaced': z.object({
      newSceneCount: z.number(),
    }),

    // Image generation progress
    'variant-image:progress': z.object({
      shotId: z.string(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      variantImageUrl: z.string().optional(),
    }),

    // Video generation progress
    'video:progress': z.object({
      shotId: z.string(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      videoUrl: z.string().optional(),
      // In-flight retry state (#882) — see `image:progress` above. Emitted
      // before a retry attempt with `status` still `generating`.
      phase: z.enum(['generating', 'retrying']).optional(),
      attempt: z.number().int().positive().optional(),
      maxAttempts: z.number().int().positive().optional(),
      // Which video model produced this update. Optional for backward compat
      // with emitters that predate multi-model video (#545); the model-aware
      // cache invalidation and scenes-view variant switcher key off it.
      model: z.string().optional(),
      // Variant-only (#547): this update belongs to an added (alternate) model,
      // not the live primary. The cache updater must NOT write it onto the
      // primary `videoUrl`/`videoStatus` — it only refreshes the per-model
      // variant/model-list queries so the new model surfaces in the dropdown
      // without clobbering the displayed primary video.
      variantOnly: z.boolean().optional(),
      // Failure reason — carried on `failed` so the cache updater writes
      // `shots.videoError` live (see image:progress.error above). (#881)
      error: z.string().optional(),
    }),

    // Audio/music generation progress (shotId optional for sequence-level music)
    'audio:progress': z.object({
      shotId: z.string().optional(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      audioUrl: z.string().optional(),
      // Which audio model produced this update. Optional for backward compat
      // with emitters that predate multi-model audio (#546). The cache updater
      // uses it to scope live `sequences.music*` writes to the primary model
      // (so a secondary model can't clobber the primary) and to refresh the
      // per-model audio queries.
      model: z.string().optional(),
    }),

    // Character sheet generation progress (during recasting)
    'character-sheet:progress': z.object({
      characterId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      sheetImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),

    // Location reference generation progress (during recasting)
    'location-sheet:progress': z.object({
      locationId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      referenceImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),

    // Recast-triggered shot regeneration events (characters)
    'recast:start': z.object({
      characterId: z.string(),
      shotCount: z.number(),
    }),
    'recast:complete': z.object({
      characterId: z.string(),
      successCount: z.number(),
      failedCount: z.number(),
    }),
    'recast:failed': z.object({
      characterId: z.string(),
      error: z.string(),
    }),

    // Recast-location events
    'recast-location:start': z.object({
      locationId: z.string(),
      shotCount: z.number(),
    }),
    'recast-location:complete': z.object({
      locationId: z.string(),
      successCount: z.number(),
      failedCount: z.number(),
    }),
    'recast-location:failed': z.object({
      locationId: z.string(),
      error: z.string(),
    }),

    // Replace-element events: edit affected shots to swap an element
    'replace-element:start': z.object({
      elementId: z.string().min(1),
      shotCount: z.number().int().nonnegative(),
      videoCount: z.number().int().nonnegative().optional(),
    }),
    'replace-element:complete': z.object({
      elementId: z.string().min(1),
      successCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      videoSuccessCount: z.number().int().nonnegative().optional(),
      videoFailedCount: z.number().int().nonnegative().optional(),
      /** Token after any vision-driven auto-rename. */
      renamedTo: z.string().min(1).optional(),
    }),
    'replace-element:failed': z.object({
      elementId: z.string().min(1),
      error: z.string().min(1),
    }),

    // Location matching events
    'location:matched': z.object({
      matches: z.array(
        z.object({
          locationId: z.string(),
          libraryLocationId: z.string(),
          libraryLocationName: z.string(),
          referenceImageUrl: z.string(),
          description: z.string().optional(),
        })
      ),
    }),

    // Talent matching events (during sequence generation)
    'talent:matched': z.object({
      matches: z.array(
        z.object({
          characterId: z.string(),
          characterName: z.string(),
          talentId: z.string(),
          talentName: z.string(),
        })
      ),
    }),
    'talent:unmatched': z.object({
      unusedTalentIds: z.array(z.string()),
      unusedTalentNames: z.array(z.string()),
    }),

    // Poster image ready (sequence-level preview from script)
    'poster:ready': z.object({
      posterUrl: z.string(),
    }),

    // Automatic style derived from the script and written to its row (#1213)
    'style:ready': z.object({
      styleId: z.string(),
      name: z.string(),
    }),

    // Divergence detected: a workflow finished but its inputs no longer match
    // the snapshot it was triggered from. The divergent result has been parked
    // (see workflow-snapshots-and-content-hash-staleness.md § "Divergence-on-completion")
    // so the live primary artifact is preserved. The UI uses this to surface
    // an "alternate available" affordance without polling.
    //
    // Discriminated by `entityType` so consumers can narrow the artifact enum
    // per-branch and rely on `divergedVariantId` being present (every current
    // emitter parks its result and references the new variant row's id; the
    // helpers in `sheet-divergence.ts` and `regenerate-shots-workflow.ts` are
    // the sole emit sites). A flat `z.object` here would let consumers redeclare
    // the payload locally with a wider `entityType: string`, which is what
    // masked the round-1 talent-channel routing bug.
    'stale:detected': z.discriminatedUnion('entityType', [
      z.object({
        entityType: z.literal('shot'),
        entityId: z.string(),
        artifact: z.enum(['thumbnail', 'variant-image', 'video', 'audio']),
        snapshotInputHash: z.string(),
        divergedVariantId: z.string(),
      }),
      z.object({
        entityType: z.literal('character'),
        entityId: z.string(),
        artifact: z.literal('sheet'),
        snapshotInputHash: z.string(),
        divergedVariantId: z.string(),
      }),
      z.object({
        entityType: z.literal('location'),
        entityId: z.string(),
        artifact: z.literal('sheet'),
        snapshotInputHash: z.string(),
        divergedVariantId: z.string(),
      }),
      z.object({
        entityType: z.literal('library-location'),
        entityId: z.string(),
        artifact: z.literal('sheet'),
        snapshotInputHash: z.string(),
        divergedVariantId: z.string(),
      }),
      z.object({
        entityType: z.literal('talent'),
        entityId: z.string(),
        artifact: z.literal('sheet'),
        snapshotInputHash: z.string(),
        divergedVariantId: z.string(),
      }),
      // Sequence-level divergent music: the music track diverged from the
      // live primary. `entityId` is the sequenceId; the divergent row sits in
      // `sequence_music_variants`.
      z.object({
        entityType: z.literal('sequence'),
        entityId: z.string(),
        artifact: z.literal('music'),
        snapshotInputHash: z.string(),
        divergedVariantId: z.string(),
      }),
    ]),

    // Sequence events
    updated: z.object({
      title: z.string().optional(),
    }),
    failed: z.object({
      message: z.string(),
    }),
    // Terminal events
    complete: z.object({
      sequenceId: z.string(),
    }),
    error: z.object({
      message: z.string(),
      phase: z.number().optional(),
    }),
  },
};

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
            body: JSON.stringify({ event, data }),
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
