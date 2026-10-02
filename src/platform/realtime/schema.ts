import type { EventPaths } from '@/platform/server/realtime/shared-types';
import { z } from 'zod';

/** Which sheet render a progress event is about; the wire shape lives with the transport. */
export const sheetProgressActivitySchema = z.enum(['sheet', 'portrait']);
export type SheetProgressActivity = z.infer<typeof sheetProgressActivitySchema>;

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
  // SSE cost. Payload is enough to patch the balance query; clients refetch it
  // only when the payload cannot settle it (#1881), and always invalidate
  // transactions.
  billing: {
    'balance:updated': z.object({
      teamId: z.string(),
      /** Posted ledger balance in USD. */
      balanceUsd: z.number(),
      /** Spendable funds (posted minus unexpired holds, #1310). */
      availableUsd: z.number(),
      /** Sum of unexpired reservation remaining. */
      reservedUsd: z.number(),
      /**
       * D1 clock (ms) when the snapshot was read. Events can arrive out of
       * order; the client keeps the newest snapshot (#1881).
       */
      asOfMs: z.number(),
      /** Signed ledger amount in USD (negative for usage, positive for top-ups). */
      amountUsd: z.number(),
      /** Absent on hold-only snapshots (create/grow/zero). */
      transactionId: z.string().optional(),
      type: z
        .enum([
          'credit_purchase',
          'credit_usage',
          'credit_refund',
          'credit_adjustment',
        ])
        .optional(),
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
        'dialogue-audio',
        'audio-design',
        'music-design',
      ]),
      // No payload beyond the id: the client refetches (#1067). The whole
      // Scene used to ride here and every emit is persisted to history, which
      // is what OOMed the replay (#1811).
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
      // A failed upscale's reason (#1942). The shot keeps its still and reads
      // `completed`, so this is the only signal the user gets; the client
      // toasts it.
      upscaleError: z.string().optional(),
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

    // Video generation progress. 'cancelled' (#1108): a user cancelled the
    // in-flight render — terminal, neutral (no failure banner), never
    // retriable.
    'video:progress': z.object({
      shotId: z.string(),
      status: z.enum([
        'pending',
        'generating',
        'completed',
        'failed',
        'cancelled',
      ]),
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
      // Content-checker rescue (#1373) — see image:progress above. Set on the
      // retrying emit when this run appended a `softened` motion prompt
      // version / swapped the clip to the fallback video model.
      promptSoftened: z.boolean().optional(),
      modelFallback: z.boolean().optional(),
    }),

    // Audio/music generation progress (shotId optional for sequence-level music)
    'audio:progress': z.object({
      shotId: z.string().optional(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      audioUrl: z.string().optional(),
      // Which audio model produced this update (#546) — refreshes the
      // per-model audio queries.
      model: z.string().optional(),
      // False for an added model's track run (#546, #1115): it never touches
      // the sequence's music, so the cache updater leaves the sequence alone.
      // Absent = the sequence's own track (every other emitter).
      primary: z.boolean().optional(),
    }),

    // Character sheet generation progress (during recasting)
    'character-sheet:progress': z.object({
      characterId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      // In-flight content-flag retry (#882 shape): `status` stays
      // `generating`; absent on the first attempt and on terminal events.
      phase: z.enum(['generating', 'retrying']).optional(),
      attempt: z.number().int().positive().optional(),
      maxAttempts: z.number().int().positive().optional(),
      promptSoftened: z.boolean().optional(),
      sheetImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),

    // Character voice design progress (#1553)
    'character-voice:progress': z.object({
      characterId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      error: z.string().optional(),
    }),

    // Location reference generation progress (during recasting)
    'location-sheet:progress': z.object({
      locationId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      phase: z.enum(['generating', 'retrying']).optional(),
      attempt: z.number().int().positive().optional(),
      maxAttempts: z.number().int().positive().optional(),
      promptSoftened: z.boolean().optional(),
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
    /**
     * Scene-split found more work than the click envelope can grow to cover.
     * Split/bibles/prompts stay; stills and motion do not spawn (#1310).
     */
    'reservation:short': z.object({
      neededUsd: z.number(),
      remainingUsd: z.number(),
      sceneCount: z.number(),
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

export const realtimeLeaves = {
  'talent.sheet:progress': realtimeSchema.talent['sheet:progress'],
  'location.sheet:progress': realtimeSchema.location['sheet:progress'],
  'billing.balance:updated': realtimeSchema.billing['balance:updated'],
  'shotPrompt.streaming': realtimeSchema.shotPrompt.streaming,
  'shotPrompt.completed': realtimeSchema.shotPrompt.completed,
  'shotPrompt.failed': realtimeSchema.shotPrompt.failed,
  'generation.phase:start': realtimeSchema.generation['phase:start'],
  'generation.phase:complete': realtimeSchema.generation['phase:complete'],
  'generation.scene:new': realtimeSchema.generation['scene:new'],
  'generation.scene:updated': realtimeSchema.generation['scene:updated'],
  'generation.shot:created': realtimeSchema.generation['shot:created'],
  'generation.shot:updated': realtimeSchema.generation['shot:updated'],
  'generation.image:progress': realtimeSchema.generation['image:progress'],
  'generation.preview:replaced': realtimeSchema.generation['preview:replaced'],
  'generation.variant-image:progress':
    realtimeSchema.generation['variant-image:progress'],
  'generation.video:progress': realtimeSchema.generation['video:progress'],
  'generation.audio:progress': realtimeSchema.generation['audio:progress'],
  'generation.character-sheet:progress':
    realtimeSchema.generation['character-sheet:progress'],
  'generation.character-voice:progress':
    realtimeSchema.generation['character-voice:progress'],
  'generation.location-sheet:progress':
    realtimeSchema.generation['location-sheet:progress'],
  'generation.recast:start': realtimeSchema.generation['recast:start'],
  'generation.recast:complete': realtimeSchema.generation['recast:complete'],
  'generation.recast:failed': realtimeSchema.generation['recast:failed'],
  'generation.recast-location:start':
    realtimeSchema.generation['recast-location:start'],
  'generation.recast-location:complete':
    realtimeSchema.generation['recast-location:complete'],
  'generation.recast-location:failed':
    realtimeSchema.generation['recast-location:failed'],
  'generation.replace-element:start':
    realtimeSchema.generation['replace-element:start'],
  'generation.replace-element:complete':
    realtimeSchema.generation['replace-element:complete'],
  'generation.replace-element:failed':
    realtimeSchema.generation['replace-element:failed'],
  'generation.location:matched': realtimeSchema.generation['location:matched'],
  'generation.talent:matched': realtimeSchema.generation['talent:matched'],
  'generation.talent:unmatched': realtimeSchema.generation['talent:unmatched'],
  'generation.poster:ready': realtimeSchema.generation['poster:ready'],
  'generation.style:ready': realtimeSchema.generation['style:ready'],
  'generation.stale:detected': realtimeSchema.generation['stale:detected'],
  'generation.updated': realtimeSchema.generation.updated,
  'generation.failed': realtimeSchema.generation.failed,
  'generation.reservation:short':
    realtimeSchema.generation['reservation:short'],
  'generation.complete': realtimeSchema.generation.complete,
  'generation.error': realtimeSchema.generation.error,
} as const;

type LeafPath = keyof typeof realtimeLeaves;

type LeavesMatchSchema =
  EventPaths<typeof realtimeSchema> extends LeafPath
    ? LeafPath extends EventPaths<typeof realtimeSchema>
      ? true
      : never
    : never;

function parseWith<S extends z.ZodType>(
  schema: S,
  data: unknown
): z.output<S> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

type LeafParsers = {
  [E in LeafPath]: (
    data: unknown
  ) => z.output<(typeof realtimeLeaves)[E]> | null;
};

// One function per leaf. Indexing the schema map and calling `.safeParse`
// widens every leaf into one union, and Zod then collapses the outputs.
const leafParsers: LeafParsers = {
  'talent.sheet:progress': (data) =>
    parseWith(realtimeLeaves['talent.sheet:progress'], data),
  'location.sheet:progress': (data) =>
    parseWith(realtimeLeaves['location.sheet:progress'], data),
  'billing.balance:updated': (data) =>
    parseWith(realtimeLeaves['billing.balance:updated'], data),
  'shotPrompt.streaming': (data) =>
    parseWith(realtimeLeaves['shotPrompt.streaming'], data),
  'shotPrompt.completed': (data) =>
    parseWith(realtimeLeaves['shotPrompt.completed'], data),
  'shotPrompt.failed': (data) =>
    parseWith(realtimeLeaves['shotPrompt.failed'], data),
  'generation.phase:start': (data) =>
    parseWith(realtimeLeaves['generation.phase:start'], data),
  'generation.phase:complete': (data) =>
    parseWith(realtimeLeaves['generation.phase:complete'], data),
  'generation.scene:new': (data) =>
    parseWith(realtimeLeaves['generation.scene:new'], data),
  'generation.scene:updated': (data) =>
    parseWith(realtimeLeaves['generation.scene:updated'], data),
  'generation.shot:created': (data) =>
    parseWith(realtimeLeaves['generation.shot:created'], data),
  'generation.shot:updated': (data) =>
    parseWith(realtimeLeaves['generation.shot:updated'], data),
  'generation.image:progress': (data) =>
    parseWith(realtimeLeaves['generation.image:progress'], data),
  'generation.preview:replaced': (data) =>
    parseWith(realtimeLeaves['generation.preview:replaced'], data),
  'generation.variant-image:progress': (data) =>
    parseWith(realtimeLeaves['generation.variant-image:progress'], data),
  'generation.video:progress': (data) =>
    parseWith(realtimeLeaves['generation.video:progress'], data),
  'generation.audio:progress': (data) =>
    parseWith(realtimeLeaves['generation.audio:progress'], data),
  'generation.character-sheet:progress': (data) =>
    parseWith(realtimeLeaves['generation.character-sheet:progress'], data),
  'generation.character-voice:progress': (data) =>
    parseWith(realtimeLeaves['generation.character-voice:progress'], data),
  'generation.location-sheet:progress': (data) =>
    parseWith(realtimeLeaves['generation.location-sheet:progress'], data),
  'generation.recast:start': (data) =>
    parseWith(realtimeLeaves['generation.recast:start'], data),
  'generation.recast:complete': (data) =>
    parseWith(realtimeLeaves['generation.recast:complete'], data),
  'generation.recast:failed': (data) =>
    parseWith(realtimeLeaves['generation.recast:failed'], data),
  'generation.recast-location:start': (data) =>
    parseWith(realtimeLeaves['generation.recast-location:start'], data),
  'generation.recast-location:complete': (data) =>
    parseWith(realtimeLeaves['generation.recast-location:complete'], data),
  'generation.recast-location:failed': (data) =>
    parseWith(realtimeLeaves['generation.recast-location:failed'], data),
  'generation.replace-element:start': (data) =>
    parseWith(realtimeLeaves['generation.replace-element:start'], data),
  'generation.replace-element:complete': (data) =>
    parseWith(realtimeLeaves['generation.replace-element:complete'], data),
  'generation.replace-element:failed': (data) =>
    parseWith(realtimeLeaves['generation.replace-element:failed'], data),
  'generation.location:matched': (data) =>
    parseWith(realtimeLeaves['generation.location:matched'], data),
  'generation.talent:matched': (data) =>
    parseWith(realtimeLeaves['generation.talent:matched'], data),
  'generation.talent:unmatched': (data) =>
    parseWith(realtimeLeaves['generation.talent:unmatched'], data),
  'generation.poster:ready': (data) =>
    parseWith(realtimeLeaves['generation.poster:ready'], data),
  'generation.style:ready': (data) =>
    parseWith(realtimeLeaves['generation.style:ready'], data),
  'generation.stale:detected': (data) =>
    parseWith(realtimeLeaves['generation.stale:detected'], data),
  'generation.updated': (data) =>
    parseWith(realtimeLeaves['generation.updated'], data),
  'generation.failed': (data) =>
    parseWith(realtimeLeaves['generation.failed'], data),
  'generation.reservation:short': (data) =>
    parseWith(realtimeLeaves['generation.reservation:short'], data),
  'generation.complete': (data) =>
    parseWith(realtimeLeaves['generation.complete'], data),
  'generation.error': (data) =>
    parseWith(realtimeLeaves['generation.error'], data),
};

export function isRealtimeLeaf(event: string): event is LeafPath {
  return Object.hasOwn(realtimeLeaves, event);
}

/** Parse one wire payload with the schema leaf for `event`. Null when it does not match. */
export function parseLeafPayload<E extends LeafPath>(
  event: E,
  channel: string,
  data: unknown
): {
  event: E;
  channel: string;
  data: z.output<(typeof realtimeLeaves)[E]>;
} | null {
  const parsed = leafParsers[event](data);
  if (parsed === null) return null;
  return { event, channel, data: parsed };
}

function assertLeavesMatchSchema(matched: LeavesMatchSchema): void {
  void matched;
}
assertLeavesMatchSchema(true);
