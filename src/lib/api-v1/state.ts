/**
 * The shared "state document" for a sequence — the single representation the
 * status endpoint returns today, and the same shape the phase-2 SSE stream and
 * webhook payloads will carry. It is derived from the DB (authoritative), so it
 * is correct even when the realtime channel has expired or a client never
 * subscribed. Keyed-by-id shot entries make it trivially mergeable with the
 * out-of-order realtime deltas a stream would later apply.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { SHOT_GENERATION_STATUSES } from '@/lib/db/schema/shots';
import { z } from 'zod';
import type { Style } from '@/lib/db/schema/libraries';
import {
  MUSIC_STATUSES,
  SEQUENCE_STATUSES,
  type SequenceStatus,
} from '@/lib/db/schema/sequences';
import { getLogger } from '@/shared/observability/logger';
import {
  readinessImageUrl,
  readinessVideoStatus,
  type ShotReadiness,
  type ShotView,
  toShotView,
} from '@/shared/shots/shot-view';
import { toShareableUrl } from '@/lib/storage/buckets';
import type { Sequence } from '@/lib/db/schema';
import {
  API_V1_BASE,
  type HalResource,
  halLinksSchema,
  waitLink,
  withLinks,
} from './hal';

const logger = getLogger(['openstory', 'api-v1']);

/** Sequence statuses past which no further generation happens. */
const TERMINAL_STATUSES = new Set<SequenceStatus>([
  'completed',
  'failed',
  'archived',
]);

/**
 * The response documents, as Zod schemas.
 *
 * These are the single source of truth for both the TypeScript types below
 * (`z.infer`) and the published OpenAPI component schemas (`openapi.ts` runs
 * them through `z.toJSONSchema`), so the contract we document cannot drift
 * from the shape we return. `.meta({ id })` names the OpenAPI component;
 * `.describe()` becomes its description.
 */
/** `z.iso.datetime()` would also publish a monstrous regex; format is enough. */
const isoDateTime = z.string().meta({ format: 'date-time' });

const genStatusSchema = z.object({
  status: z.enum(SHOT_GENERATION_STATUSES),
  url: z.string().nullable(),
});

const videoStatusSchema = z.object({
  status: z.enum(SHOT_GENERATION_STATUSES),
  url: z.string().nullable(),
  error: z
    .string()
    .nullable()
    .describe(
      'Why the primary render failed. On a content check this names the flagged input (the still, the prompt, or both) and the model that refused it. Null unless status is "failed".'
    ),
});

const sequenceStateShotSchema = z
  .object({
    id: z.string(),
    orderIndex: z.int(),
    title: z.string().nullable(),
    image: genStatusSchema,
    video: videoStatusSchema,
  })
  .meta({ id: 'SequenceStateShot' });

const sequenceCountsSchema = z.object({
  shots: z.int(),
  imagesReady: z.int(),
  videosReady: z.int(),
  videosFailed: z
    .int()
    .describe(
      'Shots whose video generation failed. Can be > 0 even when `status` is "completed".'
    ),
});

const sequenceStyleSchema = z
  .object({ id: z.string(), name: z.string().nullable() })
  .describe(
    "The style the sequence was generated with — `id` is the UI's `styleId` filter value; `name` is what the UI search matches on (null only if the style row fails to resolve, which the FK normally makes impossible)."
  );

const sequenceModelsSchema = z
  .object({
    analysis: z.string().describe('Script-analysis model id.'),
    image: z.string().describe('Per-shot image model id.'),
    video: z.string().describe('Per-shot video model id.'),
    music: z.string().nullable().describe('Music model id, if any.'),
  })
  .describe(
    'The models the sequence was generated with — the raw ids the UI filters/sorts on.'
  );

/**
 * The scalar fields shared by the single-sequence status document and each
 * entry of the `GET /api/v1/sequences` list page — everything except the
 * per-shot array. Built once in `buildSequenceSummary` so the two documents
 * can't drift.
 */
export const sequenceSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(SEQUENCE_STATUSES),
  statusError: z.string().nullable(),
  aspectRatio: z.string(),
  resolution: z.string(),
  style: sequenceStyleSchema,
  models: sequenceModelsSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  poster: z.object({ url: z.string() }).nullable(),
  music: z.object({
    status: z.enum(MUSIC_STATUSES),
    url: z.string().nullable(),
  }),
  counts: sequenceCountsSchema,
});

const sequenceStateSchema = sequenceSummarySchema.extend({
  shots: z.array(sequenceStateShotSchema),
});

/**
 * The wire shape: a state document always ships with its `_links` catalog.
 * `.meta({ id })` goes here, not on the bare body, because `.extend()` mints a
 * new schema and drops the tag — a component named on the body would be
 * published but never referenced.
 */
export const sequenceStateResourceSchema = sequenceStateSchema
  .extend({ _links: halLinksSchema })
  .meta({ id: 'SequenceState' });

/**
 * Server-side MP4 export documents (`/api/v1/sequences/:id/exports`). Here
 * rather than in the route so `openapi.ts` publishes the shape the route
 * actually returns — `formatExport` is typed by `SequenceExportDocument`.
 */
const sequenceExportSchema = z
  .object({
    id: z.string(),
    status: z.enum(['processing', 'ready', 'failed']),
    url: z
      .string()
      .nullable()
      .describe(
        'Absolute download URL, present only when `status` is `ready`.'
      ),
    durationSeconds: z.number().nullable(),
    error: z
      .string()
      .nullable()
      .describe('Failure reason, present only when `status` is `failed`.'),
    createdAt: isoDateTime,
    workflowRunId: z.string().optional(),
  })
  .describe('One server-side MP4 export of a sequence.')
  .meta({ id: 'SequenceExport' });

export const sequenceExportsResultSchema = z
  .object({
    sequenceId: z.string(),
    exports: z.array(sequenceExportSchema),
    _links: halLinksSchema,
  })
  .meta({ id: 'SequenceExportsResult' });

export const sequenceExportAcceptedSchema = z
  .object({ export: sequenceExportSchema, _links: halLinksSchema })
  .meta({ id: 'SequenceExportAccepted' });

export type SequenceExportDocument = z.infer<typeof sequenceExportSchema>;

export type SequenceCounts = z.infer<typeof sequenceCountsSchema>;
export type SequenceSummary = z.infer<typeof sequenceSummarySchema>;
export type SequenceState = z.infer<typeof sequenceStateSchema>;

/** The image URL a shot exposes once its still is ready (else null). */
function shotImageUrl(shot: ShotView): string | null {
  return readinessImageUrl({
    selectedImageUrl: shot.image?.url ?? null,
    previewImageUrl: shot.previewThumbnailUrl,
  });
}

/** The readiness slice of an already-assembled view. */
export function toShotReadiness(shot: ShotView): ShotReadiness {
  return {
    selectedImageUrl: shot.image?.url ?? null,
    previewImageUrl: shot.previewThumbnailUrl,
    hasSelectedVideo: shot.video !== null,
    primaryVideoStatus: shot.primaryVideo?.status ?? null,
  };
}

/**
 * Readiness tallies over a sequence's shots — the single source of truth for
 * the `counts` block shared by the status document and the list summary.
 *
 * Takes the narrow {@link ShotReadiness} rather than a full `ShotView` so the
 * list page can count without materialising every shot's prompts and metadata
 * (#1161). The status document, which needs the full views anyway, maps them
 * through {@link toShotReadiness}.
 */
export function summarizeShotCounts(shots: ShotReadiness[]): SequenceCounts {
  let imagesReady = 0;
  let videosReady = 0;
  let videosFailed = 0;
  for (const shot of shots) {
    if (readinessImageUrl(shot) !== null) imagesReady += 1;
    const videoStatus = readinessVideoStatus(shot);
    if (videoStatus === 'completed') videosReady += 1;
    if (videoStatus === 'failed') videosFailed += 1;
  }
  return { shots: shots.length, imagesReady, videosReady, videosFailed };
}

/**
 * Build the scalar summary fields shared by the status document and each list
 * entry. `style` is the sequence's resolved style row (null if it couldn't be
 * loaded — the `id` is still surfaced). `origin` absolutizes stored media URLs
 * (see `buildSequenceState`).
 */
export function buildSequenceSummary(params: {
  sequence: Sequence;
  style: Style | null;
  counts: SequenceCounts;
  origin: string;
}): SequenceSummary {
  const { sequence, style, counts, origin } = params;
  const share = (url: string | null): string | null =>
    url === null ? null : toShareableUrl(url, origin);

  if (style === null) {
    // styleId is notNull behind an FK, so a sequence should always resolve to a
    // style row. A miss means the FK was bypassed (manual edit, or a migration
    // run with foreign_keys off) — surface it rather than silently shipping a
    // nameless style to API consumers and the dashboard.
    logger.error('api/v1 sequence style did not resolve: {styleId}', {
      sequenceId: sequence.id,
      styleId: sequence.styleId,
    });
  }

  return {
    id: sequence.id,
    title: sequence.title,
    status: sequence.status,
    statusError: sequence.statusError ?? null,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    style: { id: sequence.styleId, name: style?.name ?? null },
    models: {
      analysis: sequence.analysisModel,
      image: sequence.imageModel,
      video: sequence.videoModel,
      music: sequence.musicModel ?? null,
    },
    createdAt: sequence.createdAt.toISOString(),
    updatedAt: sequence.updatedAt.toISOString(),
    poster: sequence.posterUrl
      ? { url: toShareableUrl(sequence.posterUrl, origin) }
      : null,
    music: {
      status: sequence.musicStatus ?? 'pending',
      url: share(sequence.musicUrl ?? null),
    },
    counts,
  };
}

export async function buildSequenceState(
  scopedDb: {
    shots: Pick<ScopedDb['shots'], 'listBySequence'>;
    frames: Pick<ScopedDb['frames'], 'listAnchorsBySequence'>;
    frameVariants: Pick<
      ScopedDb['frameVariants'],
      'getSelectedByFrameIds' | 'listLatestPreviewsByFrameIds'
    >;
    framePromptVersions: Pick<
      ScopedDb['framePromptVersions'],
      'getSelectedByFrameIds'
    >;
    videoVariants: Pick<
      ScopedDb['videoVariants'],
      'getSelectedByShotIds' | 'getPrimaryByShotIds'
    >;
    styles: Pick<ScopedDb['styles'], 'getById'>;
    scenes: Pick<ScopedDb['scenes'], 'listBySequence'>;
  },
  sequence: Sequence,
  // Scheme+host the request arrived on. Stored media URLs are origin-relative
  // (#894); the API hands them to off-origin clients, so absolutize them to a
  // shareable form (CDN domain when configured, else this origin). See
  // toShareableUrl.
  origin: string
): Promise<SequenceState> {
  const [shots, anchorRows, style, sceneRows] = await Promise.all([
    scopedDb.shots.listBySequence(sequence.id),
    scopedDb.frames.listAnchorsBySequence(sequence.id),
    scopedDb.styles.getById(sequence.styleId),
    scopedDb.scenes.listBySequence(sequence.id),
  ]);
  // A shot's title is its scene's title (#1067).
  const scenesById = new Map<string, (typeof sceneRows)[number]>(
    sceneRows.map((scene) => [scene.id, scene])
  );
  // The still lives on each shot's anchor frame (#989) — keyed by shotId, never
  // by id-reuse.
  const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
  // The still comes from the selected `frame_variants` row and the video from
  // the segment's selected `video_variants` row (#1067).
  const [
    selectedByFrame,
    previewByFrame,
    selectedPromptByFrame,
    selectedVideoByShot,
    primaryVideoByShot,
  ] = await Promise.all([
    scopedDb.frameVariants.getSelectedByFrameIds(anchorRows.map((f) => f.id)),
    // The pre-prompt stand-in is a `kind: 'preview'` row (#1101).
    scopedDb.frameVariants.listLatestPreviewsByFrameIds(
      anchorRows.map((f) => f.id)
    ),
    scopedDb.framePromptVersions.getSelectedByFrameIds(
      anchorRows.map((f) => f.id)
    ),
    scopedDb.videoVariants.getSelectedByShotIds(shots.map((s) => s.id)),
    scopedDb.videoVariants.getPrimaryByShotIds(shots.map((s) => s.id)),
  ]);
  const shotViews = shots.flatMap((shot) => {
    const frame = anchorsByShot.get(shot.id);
    return frame
      ? [
          toShotView(shot, frame, {
            image: selectedByFrame.get(frame.id) ?? null,
            preview: previewByFrame.get(frame.id) ?? null,
            imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
            video: selectedVideoByShot.get(shot.id) ?? null,
            primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
          }),
        ]
      : [];
  });
  // Already in hierarchical order from the read path.
  const ordered = shotViews;
  const share = (url: string | null): string | null =>
    url === null ? null : toShareableUrl(url, origin);

  const stateShots: SequenceState['shots'] = ordered.map((shot, index) => {
    const imageUrl = shotImageUrl(shot);
    return {
      id: shot.id,
      orderIndex: index,
      title:
        (shot.sceneId ? scenesById.get(shot.sceneId)?.title : null) ?? null,
      image: {
        status: imageUrl ? 'completed' : 'pending',
        url: share(imageUrl),
      },
      video: {
        // The public doc never surfaces 'cancelled' (#1108) — mirroring the
        // image side, where a cancel settles the frame back to
        // completed/pending. A cancelled render means "nothing new happened":
        // the selected video (if any) still stands.
        status:
          shot.videoStatus === 'cancelled'
            ? shot.video?.url
              ? 'completed'
              : 'pending'
            : shot.videoStatus,
        url: share(shot.video?.url ?? null),
        error:
          shot.videoStatus === 'failed'
            ? (shot.primaryVideo?.error ?? null)
            : null,
      },
    };
  });

  return {
    ...buildSequenceSummary({
      sequence,
      style,
      counts: summarizeShotCounts(ordered.map(toShotReadiness)),
      origin,
    }),
    shots: stateShots,
  };
}

/** True once a sequence can no longer change (completed / failed / archived). */
export function isTerminalSequenceState(state: SequenceState): boolean {
  return TERMINAL_STATUSES.has(state.status);
}

/**
 * A compact change-detection key for `?wait=` long-polling. It folds in every
 * field an agent polls for progress on, so the poll returns the instant any of
 * them advances — overall status, music, poster, per-kind ready counts, and
 * video failures (so a failing shot wakes the poll instead of stalling it
 * until the deadline).
 */
export function sequenceStateCursor(state: SequenceState): string {
  return [
    state.status,
    state.updatedAt,
    state.music.status,
    state.poster ? '1' : '0',
    state.counts.imagesReady,
    state.counts.videosReady,
    state.counts.videosFailed,
  ].join('|');
}

/** Attach the HAL affordance catalog (self + long-poll) to a sequence state. */
export function withSequenceStateLinks(
  state: SequenceState
): HalResource<SequenceState> {
  const href = `${API_V1_BASE}/sequences/${state.id}`;
  return withLinks(state, {
    self: { href, method: 'GET', title: 'Sequence status' },
    poll: waitLink(
      href,
      'Long-poll until this sequence changes (e.g. ?wait=60s)'
    ),
    exports: {
      href: `${href}/exports`,
      method: 'GET',
      title: 'List server-side MP4 exports of this sequence',
    },
    'create-export': {
      href: `${href}/exports`,
      method: 'POST',
      title: 'Start a server-side MP4 export of this sequence',
      contentType: 'application/json',
      examples: [{}],
    },
  });
}
