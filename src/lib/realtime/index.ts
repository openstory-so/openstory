import { getRedis } from '#redis';
import { Realtime } from '@upstash/realtime';
import { z } from 'zod';

import { getLogger } from '@/lib/observability/logger';

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

  // Per-frame prompt regeneration events. Lives on its own channel
  // (`frame-prompt:${frameId}`) so a client only pays the realtime cost while
  // it's actually viewing the frame, and history replay rebuilds the
  // streaming-text state for the active prompt type if the user navigates
  // away and back mid-generation. The `delta` carries the incremental visible
  // characters of the `fullPrompt` field — extraction happens server-side via
  // `extractStreamingStringField` so the client doesn't have to parse partial
  // JSON.
  framePrompt: {
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

    // Frame events (after DB write)
    'frame:created': z.object({
      frameId: z.string(),
      sceneId: z.string(),
      orderIndex: z.number(),
    }),

    // Frame updated with prompts (visual, motion, audio)
    'frame:updated': z.object({
      frameId: z.string(),
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
      frameId: z.string(),
      status: z
        .enum(['pending', 'generating', 'completed', 'failed'])
        .optional(),
      thumbnailUrl: z.string().optional(),
      previewThumbnailUrl: z.string().optional(),
      model: z.string().optional(),
    }),

    // Fast preview frames replaced by AI-analyzed frames
    'preview:replaced': z.object({
      newSceneCount: z.number(),
    }),

    // Image generation progress
    'variant-image:progress': z.object({
      frameId: z.string(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      variantImageUrl: z.string().optional(),
    }),

    // Video generation progress
    'video:progress': z.object({
      frameId: z.string(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      videoUrl: z.string().optional(),
      // Which video model produced this update. Optional for backward compat
      // with emitters that predate multi-model video (#545); the model-aware
      // cache invalidation and scenes-view variant switcher key off it.
      model: z.string().optional(),
    }),

    // Audio/music generation progress (frameId optional for sequence-level music)
    'audio:progress': z.object({
      frameId: z.string().optional(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      audioUrl: z.string().optional(),
      // Which audio model produced this update. Optional for backward compat
      // with emitters that predate multi-model audio (#546); the model-aware
      // cache invalidation and the music-view track switcher key off it.
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

    // Recast-triggered frame regeneration events (characters)
    'recast:start': z.object({
      characterId: z.string(),
      frameCount: z.number(),
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
      frameCount: z.number(),
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

    // Replace-element events: edit affected frames to swap an element
    'replace-element:start': z.object({
      elementId: z.string().min(1),
      frameCount: z.number().int().nonnegative(),
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

    // Divergence detected: a workflow finished but its inputs no longer match
    // the snapshot it was triggered from. The divergent result has been parked
    // (see workflow-snapshots-and-content-hash-staleness.md § "Divergence-on-completion")
    // so the live primary artifact is preserved. The UI uses this to surface
    // an "alternate available" affordance without polling.
    //
    // Discriminated by `entityType` so consumers can narrow the artifact enum
    // per-branch and rely on `divergedVariantId` being present (every current
    // emitter parks its result and references the new variant row's id; the
    // helpers in `sheet-divergence.ts` and `regenerate-frames-workflow.ts` are
    // the sole emit sites). A flat `z.object` here would let consumers redeclare
    // the payload locally with a wider `entityType: string`, which is what
    // masked the round-1 talent-channel routing bug.
    'stale:detected': z.discriminatedUnion('entityType', [
      z.object({
        entityType: z.literal('frame'),
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

let realtimeInstance: ReturnType<typeof createRealtime> | null = null;

function createRealtime() {
  const redis = getRedis();
  return new Realtime({
    schema: realtimeSchema,
    redis,
    maxDurationSecs: 10,
    history: {
      expireAfterSecs: 60 * 60 * 24 * 30, // 30 days
    },
  });
}

/**
 * Get the Realtime instance for emitting/subscribing to events.
 * Lazily initialized to avoid errors when Redis env vars are not set.
 */
export function getRealtime() {
  if (realtimeInstance) return realtimeInstance;
  realtimeInstance = createRealtime();
  return realtimeInstance;
}

/**
 * Build a no-op channel stub when an id is missing. Logs a warning so a
 * dropped emit is observable in production rather than silently lost — the
 * channel-id helpers below are server-only, and a missing id is always a
 * bug at the call site.
 */
function noopChannel(label: string): { emit: () => null } {
  logger.warn(
    `dropping ${label} emit: missing channel id — caller should guard on id presence before emitting`
  );
  return { emit: () => null };
}

/**
 * Get a channel for a specific sequence to emit/receive events.
 * @param sequenceId - The sequence ID to use as the channel identifier
 */
export function getGenerationChannel(sequenceId?: string) {
  return sequenceId
    ? getRealtime().channel(sequenceId)
    : noopChannel('generation');
}

/**
 * Get a channel for talent library events.
 * @param talentId - The talent ID to use as the channel identifier
 */
export function getTalentChannel(talentId?: string) {
  return talentId
    ? getRealtime().channel(`talent:${talentId}`)
    : noopChannel('talent');
}

/**
 * Get a channel for location library events.
 * @param locationId - The location ID to use as the channel identifier
 */
export function getLocationChannel(locationId?: string) {
  return locationId
    ? getRealtime().channel(`location:${locationId}`)
    : noopChannel('location');
}

/**
 * Get a channel for per-frame prompt regeneration streaming.
 * @param frameId - The frame ID to use as the channel identifier
 */
export function getFramePromptChannel(frameId?: string) {
  return frameId
    ? getRealtime().channel(`frame-prompt:${frameId}`)
    : noopChannel('frame-prompt');
}

/** Build the channel id for a frame's prompt-regen events. */
export function framePromptChannelId(frameId: string): string {
  return `frame-prompt:${frameId}`;
}
