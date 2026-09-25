/**
 * Scoped Sequences Sub-module
 * Team-scoped sequence CRUD and per-sequence update methods.
 */

import { withSequencePosters } from './sequence-poster';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/models/models';
import { type AspectRatio, DEFAULT_ASPECT_RATIO } from '@/models/aspect-ratios';
import { DEFAULT_RESOLUTION, type Resolution } from '@/models/resolutions';
import type { Database } from '@/platform/server/db/client';
import {
  assembleShotViews,
  selectShotViewRows,
  shotHierarchicalOrder,
} from '@/shots/server/db/shot-view-query';
import {
  frames,
  frameVariants,
  renderSegments,
  sequenceStyleVersions,
  sequences,
  shots,
  styles,
  videoVariants,
} from '@/platform/server/db/schema';
import type {
  Frame,
  NewSequence,
  Sequence,
  SequenceStyleSource,
  Shot,
  StoredStyleConfig,
} from '@/platform/server/db/schema';
import type {
  MusicStatus,
  SequenceStatus,
} from '@/platform/server/db/schema/sequences';
import type {
  GenerationCheckpoint,
  GenerationStage,
} from '@/sequences/pipeline';
import { parseStyleConfig } from '@/look/style-config';
import type { ShotReadiness, ShotView } from '@/shots/shot-view';
import { getLatestPreviewByFrameIds } from '@/stills/server/db/frame-variants';
import { getPrimaryVideoByShotIds } from '@/motion/server/db/video-variants';
import {
  buildEventInsert,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_CHANGED_LABELS,
} from './sequence-events';
import { ValidationError } from '@/platform/errors';
import { demoteSequenceSheetClaims } from '@/cast/server/db/sheet-claims';

/**
 * {@link ShotReadiness} plus the scalars a production status derives from: which
 * attempt is in flight or failed, and whether the shot even takes a start frame.
 * Still one narrow row per shot — no prompts, manifests or metadata (#1161).
 */
export type ShotProductionReadiness = ShotReadiness &
  Pick<Shot, 'sequenceId' | 'useStartFrame' | 'renderSegmentId'> & {
    shotId: string;
    /** Null while the selected render has no file, even though it is selected. */
    selectedVideoUrl: string | null;
    imageStatus: Frame['imageStatus'] | null;
    imageWorkflowRunId: string | null;
    primaryVideoId: string | null;
    videoWorkflowRunId: string | null;
    videoError: string | null;
  };
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  not,
  or,
  sql,
} from 'drizzle-orm';
import { generateId } from '@/platform/id';

// The row's own columns: the legacy snapshot is read only through the fallback.
const { legacyStyleConfig: _legacyStyleConfig, ...sequenceRecordColumns } =
  getTableColumns(sequences);

/**
 * Sequence columns with the style snapshot resolved from the selected
 * `sequence_style_versions` row (#1600) — the one reader of the snapshot. A
 * sequence with no version reads the legacy column: null for a new row, the
 * old snapshot for one a pre-#1600 worker wrote. Needs {@link joinSelectedStyle}.
 */
export const sequenceColumns = {
  ...sequenceRecordColumns,
  styleConfig:
    sql<StoredStyleConfig | null>`CASE WHEN ${sequenceStyleVersions.id} IS NULL THEN ${sequences.legacyStyleConfig} ELSE ${sequenceStyleVersions.config} END`.mapWith(
      sequenceStyleVersions.config
    ),
};

/** The join {@link sequenceColumns} reads from. */
export const joinSelectedStyle = eq(
  sequenceStyleVersions.id,
  sequences.selectedStyleVersionId
);

/** The statement that records a style snapshot as a version row. */
const insertStyleVersion = (
  db: Database,
  row: {
    id: string;
    sequenceId: string;
    styleId: string;
    config: StoredStyleConfig;
    source: SequenceStyleSource;
    createdBy: string | null;
  }
) => db.insert(sequenceStyleVersions).values(row);

export type MusicFieldsUpdate = {
  musicStatus?: MusicStatus;
  musicModel?: string;
  musicError?: string | null;
  musicUrl?: string;
  musicPath?: string;
  musicGeneratedAt?: Date;
};

// D1 caps a single query at 100 bound parameters. `listShotsByIds` binds one
// param per sequence id plus the teamId filter, so each query must stay under
// that ceiling. We chunk the ids well below 100 and union the results; without
// this a team with enough sequences overflows the limit (and previously tripped
// the 500-item request cap on `getShotsForSequencesFn` — see #957).
const SHOTS_BY_IDS_BATCH = 90;

/** `select(sequenceColumns)` + the join it reads from. */
export const selectSequencesFrom = (db: Database) =>
  db
    .select(sequenceColumns)
    .from(sequences)
    .leftJoin(sequenceStyleVersions, joinSelectedStyle);

function createSequencesReadMethods(db: Database, teamId: string) {
  const selectSequences = () => selectSequencesFrom(db);
  return {
    list: async (): Promise<Sequence[]> => {
      const rows = await selectSequences()
        .where(
          and(
            eq(sequences.teamId, teamId),
            not(eq(sequences.status, 'archived'))
          )
        )
        .orderBy(desc(sequences.updatedAt));
      return withSequencePosters(db, rows);
    },

    /** The team's archived sequences — the unarchive picker (#1108 Phase 4). */
    listArchived: async (): Promise<Sequence[]> => {
      return await selectSequences()
        .where(
          and(eq(sequences.teamId, teamId), eq(sequences.status, 'archived'))
        )
        .orderBy(desc(sequences.updatedAt));
    },

    /**
     * Keyset-paginated, most-recent-first page of the team's non-archived
     * sequences — backs the public `GET /api/v1/sequences` list. Ordered by
     * `(updatedAt, id)` descending so the `id` tiebreaker keeps the order total
     * even when several rows share an `updatedAt` second. Pass the last row's
     * `(updatedAt, id)` as `cursor` to fetch the next page. Fetches `limit + 1`
     * rows so the caller can tell whether a further page exists without a second
     * query.
     */
    listPage: async (params: {
      limit: number;
      cursor: { updatedAt: Date; id: string } | null;
    }): Promise<Sequence[]> => {
      const { limit, cursor } = params;
      return await selectSequences()
        .where(
          and(
            eq(sequences.teamId, teamId),
            not(eq(sequences.status, 'archived')),
            cursor
              ? or(
                  lt(sequences.updatedAt, cursor.updatedAt),
                  and(
                    eq(sequences.updatedAt, cursor.updatedAt),
                    lt(sequences.id, cursor.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(desc(sequences.updatedAt), desc(sequences.id))
        .limit(limit + 1);
    },

    /**
     * Every style snapshot of a team sequence, oldest first (#1600).
     * Staleness causes diff the one live when an artifact was made against
     * the live one.
     */
    listStyleVersions: async (sequenceId: string) =>
      await db
        .select(getTableColumns(sequenceStyleVersions))
        .from(sequenceStyleVersions)
        .innerJoin(
          sequences,
          eq(sequences.id, sequenceStyleVersions.sequenceId)
        )
        .where(
          and(
            eq(sequenceStyleVersions.sequenceId, sequenceId),
            eq(sequences.teamId, teamId)
          )
        )
        .orderBy(
          asc(sequenceStyleVersions.createdAt),
          asc(sequenceStyleVersions.id)
        ),

    getById: async (sequenceId: string): Promise<Sequence | null> => {
      const result = await selectSequences().where(
        and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId))
      );
      return result[0] ?? null;
    },

    getForUser: async (params: { sequenceId: string }): Promise<Sequence> => {
      const [sequence] = await selectSequences().where(
        and(eq(sequences.id, params.sequenceId), eq(sequences.teamId, teamId))
      );
      if (!sequence) {
        throw new ValidationError('Sequence not found');
      }
      return sequence;
    },

    /**
     * Batched shot fetch for a list of sequences. Replaces N parallel
     * `shots.listBySequence` round-trips from the sequences list page — the
     * fan-out saturated iOS Chrome's connection pool and crashed the
     * WebProcess once teams accumulated >~50 sequences. teamId filter is
     * applied via the join so caller-supplied ids from another team simply
     * return nothing rather than leak.
     */
    listShotsByIds: async (sequenceIds: string[]): Promise<ShotView[]> => {
      if (sequenceIds.length === 0) return [];
      // Chunk the ids to stay under D1's bound-parameter ceiling. Each chunk
      // holds all of a sequence's shots (we split on sequence boundaries), so
      // per-sequence orderIndex ordering is preserved; cross-sequence ordering
      // is irrelevant — callers regroup by sequence id.
      const batches: string[][] = [];
      for (let i = 0; i < sequenceIds.length; i += SHOTS_BY_IDS_BATCH) {
        batches.push(sequenceIds.slice(i, i + SHOTS_BY_IDS_BATCH));
      }
      const results = await Promise.all(
        batches.map((batch) =>
          selectShotViewRows(db)
            // teamId is filtered through the join, so caller-supplied ids from
            // another team return nothing rather than leak.
            .innerJoin(sequences, eq(shots.sequenceId, sequences.id))
            .where(
              and(
                inArray(shots.sequenceId, batch),
                eq(sequences.teamId, teamId),
                // Soft-deleted shots stay out of list views (#1108).
                isNull(shots.deletedAt)
              )
            )
            .orderBy(asc(shots.sequenceId), ...shotHierarchicalOrder)
            .then((rows) => assembleShotViews(db, rows))
        )
      );
      return results.flat();
    },

    /**
     * Readiness-only twin of {@link listShotsByIds}, for callers that report
     * `counts` and never touch a shot's content.
     *
     * `listShotsByIds` projects ~100 columns per shot — `shots.metadata`, the
     * visual prompt, the motion prompt, both variant rows. `GET
     * /api/v1/sequences` paged up to 100 sequences through it to compute four
     * integers each, and the shots-per-sequence fan-out is unbounded, so the
     * page's peak footprint had no ceiling — one of the reads that reached the
     * 128 MB isolate limit (#1161). This selects the five scalars
     * {@link ShotReadiness} is derived from instead.
     *
     * The two group-wise maxes ride the SAME helpers as the full view, so
     * neither path can drift on which render counts as primary.
     */
    listShotReadinessByIds: async (
      sequenceIds: string[]
    ): Promise<ShotProductionReadiness[]> => {
      if (sequenceIds.length === 0) return [];
      const batches: string[][] = [];
      for (let i = 0; i < sequenceIds.length; i += SHOTS_BY_IDS_BATCH) {
        batches.push(sequenceIds.slice(i, i + SHOTS_BY_IDS_BATCH));
      }
      const batched = await Promise.all(
        batches.map((batch) =>
          db
            .select({
              sequenceId: shots.sequenceId,
              shotId: shots.id,
              useStartFrame: shots.useStartFrame,
              renderSegmentId: shots.renderSegmentId,
              frameId: frames.id,
              imageStatus: frames.imageStatus,
              imageWorkflowRunId: frames.imageWorkflowRunId,
              selectedImageUrl: frameVariants.url,
              selectedVideoId: videoVariants.id,
              selectedVideoUrl: videoVariants.url,
            })
            .from(shots)
            // teamId is filtered through the join, so caller-supplied ids from
            // another team return nothing rather than leak.
            .innerJoin(sequences, eq(shots.sequenceId, sequences.id))
            // Same anchor-frame and selection joins as `selectShotViewRows`:
            // all left, with `discardedAt` in the JOIN condition, so a shot
            // with no frame or a discarded selection still counts as a shot.
            .leftJoin(
              frames,
              and(eq(frames.shotId, shots.id), eq(frames.orderIndex, 0))
            )
            .leftJoin(
              frameVariants,
              and(
                eq(frameVariants.id, frames.selectedImageVersionId),
                isNull(frameVariants.discardedAt)
              )
            )
            .leftJoin(
              renderSegments,
              eq(renderSegments.id, shots.renderSegmentId)
            )
            .leftJoin(
              videoVariants,
              and(
                eq(videoVariants.id, renderSegments.selectedVideoVersionId),
                isNull(videoVariants.discardedAt)
              )
            )
            .where(
              and(
                inArray(shots.sequenceId, batch),
                eq(sequences.teamId, teamId),
                // Soft-deleted shots stay out of list counts (#1108). Twin of
                // `listShotsByIds` — public `GET /api/v1/sequences` uses this
                // path for `counts`.
                isNull(shots.deletedAt)
              )
            )
        )
      );
      const rows = batched.flat();

      const [primaryByShot, previewByFrame] = await Promise.all([
        getPrimaryVideoByShotIds(
          db,
          rows.map((row) => row.shotId)
        ),
        getLatestPreviewByFrameIds(
          db,
          rows.flatMap((row) => (row.frameId ? [row.frameId] : []))
        ),
      ]);

      return rows.map((row) => {
        const primary = primaryByShot.get(row.shotId);
        return {
          sequenceId: row.sequenceId,
          shotId: row.shotId,
          useStartFrame: row.useStartFrame,
          renderSegmentId: row.renderSegmentId,
          imageStatus: row.imageStatus,
          imageWorkflowRunId: row.imageWorkflowRunId,
          selectedImageUrl: row.selectedImageUrl ?? null,
          previewImageUrl: row.frameId
            ? (previewByFrame.get(row.frameId)?.url ?? null)
            : null,
          hasSelectedVideo: row.selectedVideoId !== null,
          selectedVideoUrl: row.selectedVideoUrl ?? null,
          primaryVideoId: primary?.id ?? null,
          primaryVideoStatus: primary?.status ?? null,
          videoWorkflowRunId: primary?.workflowRunId ?? null,
          videoError: primary?.error ?? null,
        };
      });
    },
  };
}

async function snapshotConfigForStyleId(
  db: Database,
  styleId: string
): Promise<ReturnType<typeof parseStyleConfig>> {
  const [style] = await db
    .select({ config: styles.config })
    .from(styles)
    .where(eq(styles.id, styleId))
    .limit(1);
  if (!style) {
    throw new ValidationError(`Style ${styleId} not found`);
  }
  return parseStyleConfig(style.config);
}

export function createSequencesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createSequencesReadMethods(db, teamId),

    /**
     * A new sequence; its style snapshot (#1600) lands as its first
     * `sequence_style_versions` row in the same batch, unless the automatic
     * style defers it.
     */
    create: async (params: {
      /** Pre-allocated id, for callers that bind rows to the sequence first. */
      id?: string;
      title: string;
      script?: string | null;
      styleId: string;
      /**
       * Automatic style (#1213): the style row is a placeholder until the
       * storyboard run derives the recipe, so no snapshot is taken here — a
       * null `styleConfig` is what tells the launcher the derivation is still
       * pending. The run writes the snapshot via `update({ styleId })`.
       */
      deferStyleSnapshot?: boolean;
      aspectRatio?: AspectRatio;
      resolution?: Resolution;
      analysisModel?: string;
      imageModel?: string;
      videoModel?: string;
      musicModel?: string;
      autoGenerateMotion?: boolean;
      autoGenerateMusic?: boolean;
      generationStopAt?: GenerationStage;
      /** Opt-in to the frame-based workflow; off = reference-only (the default). */
      generateStartFrames?: boolean;
      /** Design a voice per speaking character (#1553); off by default. */
      generateVoices?: boolean;
      /** Render motion as Ark drafts (#1756); off by default. */
      draftMotion?: boolean;
      /** Film length asked for (#1593); absent / null = auto. */
      targetDurationSeconds?: number | null;
      suggestedTalentIds?: string[];
      suggestedLocationIds?: string[];
    }): Promise<Sequence> => {
      const styleConfig = params.deferStyleSnapshot
        ? null
        : await snapshotConfigForStyleId(db, params.styleId);
      const id = params.id ?? generateId();
      const styleVersionId = styleConfig ? generateId() : null;
      const sequenceData: NewSequence = {
        id,
        teamId,
        createdBy: userId,
        updatedBy: userId,
        title: params.title,
        script: params.script,
        styleId: params.styleId,
        aspectRatio: params.aspectRatio ?? DEFAULT_ASPECT_RATIO,
        resolution: params.resolution ?? DEFAULT_RESOLUTION,
        // The sequences SQL column defaults are stale literals
        // ('anthropic/claude-haiku-4.5' for analysis, 'nano_banana_2' for
        // image, 'kling_v3_pro' for video — see schema/sequences.ts) that
        // can't be changed without a D1 table rebuild, so resolve the app's
        // real defaults here instead of relying on the column default.
        analysisModel: params.analysisModel ?? DEFAULT_ANALYSIS_MODEL,
        imageModel: params.imageModel ?? DEFAULT_IMAGE_MODEL,
        videoModel: params.videoModel ?? DEFAULT_VIDEO_MODEL,
        musicModel: params.musicModel,
        autoGenerateMotion: params.autoGenerateMotion ?? false,
        autoGenerateMusic: params.autoGenerateMusic ?? false,
        generationStopAt: params.generationStopAt,
        generateStartFrames: params.generateStartFrames ?? false,
        generateVoices: params.generateVoices ?? false,
        targetDurationSeconds: params.targetDurationSeconds ?? null,
        suggestedTalentIds: params.suggestedTalentIds ?? null,
        suggestedLocationIds: params.suggestedLocationIds ?? null,
        status: 'draft',
      };

      const insert = db
        .insert(sequences)
        .values({ ...sequenceData, selectedStyleVersionId: styleVersionId });
      if (styleConfig && styleVersionId) {
        await db.batch([
          insert,
          insertStyleVersion(db, {
            id: styleVersionId,
            sequenceId: id,
            styleId: params.styleId,
            config: styleConfig,
            source: 'created',
            createdBy: userId,
          }),
        ]);
      } else {
        await insert;
      }

      const [data] = await selectSequencesFrom(db).where(eq(sequences.id, id));
      if (!data) {
        throw new Error('No sequence returned from database');
      }

      return data;
    },

    /**
     * Compare-and-swap `workflowRunId` — the storyboard generation mutex
     * (#839). Writes `claimId` only if the column still holds `expectedRunId`
     * (the value the caller just read). D1 is single-writer, so exactly one
     * of two racing claims sees `true`; the loser must not trigger.
     */
    claimWorkflowSlot: async (params: {
      id: string;
      expectedRunId: string | null;
      claimId: string;
    }): Promise<boolean> => {
      const claimed = await db
        .update(sequences)
        .set({ workflowRunId: params.claimId, updatedAt: new Date() })
        .where(
          and(
            eq(sequences.id, params.id),
            eq(sequences.teamId, teamId),
            params.expectedRunId === null
              ? isNull(sequences.workflowRunId)
              : eq(sequences.workflowRunId, params.expectedRunId)
          )
        )
        .returning({ id: sequences.id });
      return claimed.length > 0;
    },

    /**
     * CAS-claim the ready-email slot (#1276). Returns true only for the first
     * caller; later retries / smart-retry re-completes see false.
     */
    claimReadyEmailSend: async (sequenceId: string): Promise<boolean> => {
      const claimed = await db
        .update(sequences)
        .set({ readyEmailSentAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(sequences.id, sequenceId),
            eq(sequences.teamId, teamId),
            isNull(sequences.readyEmailSentAt)
          )
        )
        .returning({ id: sequences.id });
      return claimed.length > 0;
    },

    /**
     * Drop the ready-email claim so a failed send can retry. Only the sender
     * that just claimed should call this.
     */
    releaseReadyEmailSend: async (sequenceId: string): Promise<void> => {
      await db
        .update(sequences)
        .set({ readyEmailSentAt: null, updatedAt: new Date() })
        .where(and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId)));
    },

    update: async (params: {
      id: string;
      title?: string;
      script?: string | null;
      styleId?: string;
      status?: SequenceStatus;
      workflowRunId?: string;
      analysisModel?: string;
      aspectRatio?: AspectRatio;
      resolution?: Resolution;
      imageModel?: string;
      videoModel?: string;
      musicModel?: string;
      musicStatus?: MusicStatus;
      musicError?: string | null;
      musicUrl?: string;
      musicPath?: string;
      musicGeneratedAt?: Date;
      posterUrl?: string | null;
      includeMusic?: boolean;
      autoGenerateMotion?: boolean;
      autoGenerateMusic?: boolean;
      generationStopAt?: GenerationStage | null;
      pipelineStage?: GenerationStage | null;
      generationCheckpoint?: GenerationCheckpoint | null;
      /**
       * Continue-from before Images (#1698): the create-time default can
       * still change because no stills exist yet. The general
       * `updateSequenceFn` path still omits this field.
       */
      generateStartFrames?: boolean;
      /** Continue-from before Dialogue (#1698). */
      generateVoices?: boolean;
      /** Render motion as Ark drafts (#1756). */
      draftMotion?: boolean;
      targetDurationSeconds?: number | null;
    }): Promise<Sequence> => {
      // Scoped by teamId like every other write here — `workflowRunId` in
      // particular is the generation-mutex column (#839), so a cross-team id
      // must never be able to stomp it.
      const { id, ...values } = params;
      const styleConfig =
        params.styleId !== undefined
          ? await snapshotConfigForStyleId(db, params.styleId)
          : undefined;
      const scoped = and(eq(sequences.id, id), eq(sequences.teamId, teamId));
      if (styleConfig !== undefined && params.styleId !== undefined) {
        const [owned] = await db
          .select({ id: sequences.id })
          .from(sequences)
          .where(scoped);
        if (!owned) {
          throw new ValidationError('Sequence not found');
        }
        // A style switch is a new snapshot (#1600): its version row, the
        // pointer, and — since the style feeds every sheet in the sequence —
        // the revoked sheet claims (#1113), in one batch.
        const styleVersionId = generateId();
        await db.batch([
          insertStyleVersion(db, {
            id: styleVersionId,
            sequenceId: id,
            styleId: params.styleId,
            config: styleConfig,
            source: 'switched',
            createdBy: userId,
          }),
          db
            .update(sequences)
            .set({ ...values, selectedStyleVersionId: styleVersionId })
            .where(scoped),
          ...demoteSequenceSheetClaims(db, id),
        ]);
      } else {
        const [updated] = await db
          .update(sequences)
          .set(values)
          .where(scoped)
          .returning({ id: sequences.id });
        if (!updated) {
          throw new ValidationError('Sequence not found');
        }
      }
      const [data] = await selectSequencesFrom(db).where(scoped);
      if (!data) {
        throw new ValidationError('Sequence not found');
      }

      // Date hash-bearing setting changes so staleness can name them (#1194);
      // style is a snapshot, so no row timestamp says when it moved.
      const fields = Object.keys(SETTINGS_CHANGED_LABELS).filter(
        (f) => f in values
      );
      if (fields.length > 0) {
        await buildEventInsert(db, {
          sequenceId: id,
          actorId: userId,
          kind: SETTINGS_CHANGED_EVENT,
          targetType: 'sequence',
          targetId: id,
          data: { fields },
        });
      }

      return data;
    },

    /**
     * Snapshot an automatic style's derived recipe onto its sequence (#1213),
     * but only while the sequence still points at that style — a library pick
     * made mid-run must not be overwritten. Returns false when it no longer does.
     */
    snapshotAutoStyle: async (params: {
      id: string;
      styleId: string;
    }): Promise<boolean> => {
      const styleConfig = await snapshotConfigForStyleId(db, params.styleId);
      const still = and(
        eq(sequences.id, params.id),
        eq(sequences.teamId, teamId),
        eq(sequences.styleId, params.styleId)
      );
      const [current] = await db
        .select({ id: sequences.id })
        .from(sequences)
        .where(still);
      if (!current) return false;
      // The derived recipe is a snapshot like any other (#1600). The pointer
      // moves only while the sequence still points at this style; a pick that
      // lands between the read and the batch leaves the row as history.
      const styleVersionId = generateId();
      const [, rows] = await db.batch([
        insertStyleVersion(db, {
          id: styleVersionId,
          sequenceId: params.id,
          styleId: params.styleId,
          config: styleConfig,
          source: 'derived',
          createdBy: null,
        }),
        db
          .update(sequences)
          .set({
            selectedStyleVersionId: styleVersionId,
            updatedAt: new Date(),
          })
          .where(still)
          .returning({ id: sequences.id }),
      ]);
      return rows.length > 0;
    },

    delete: async (sequenceId: string): Promise<void> => {
      await db.delete(sequences).where(eq(sequences.id, sequenceId));
      // An automatic style has no FK to its sequence (#1213); drop it here.
      await db
        .delete(styles)
        .where(
          and(eq(styles.sequenceId, sequenceId), eq(styles.teamId, teamId))
        );
    },

    updateTitle: async (sequenceId: string, title: string): Promise<void> => {
      await db
        .update(sequences)
        .set({ title, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateAnalysisDurationMs: async (
      sequenceId: string,
      durationMs: number
    ): Promise<void> => {
      await db
        .update(sequences)
        .set({ analysisDurationMs: durationMs, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateMusicPrompt: async (
      sequenceId: string,
      musicPrompt: string,
      musicTags: string
    ): Promise<void> => {
      await db
        .update(sequences)
        .set({ musicPrompt, musicTags, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateWorkflow: async (
      sequenceId: string,
      workflow: string
    ): Promise<void> => {
      await db
        .update(sequences)
        .set({ workflow, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },
  };
}

function createSequenceReadMethods(db: Database, sequenceId: string) {
  return {
    getMusicStatus: async () => {
      const [row] = await db
        .select({
          musicStatus: sequences.musicStatus,
          musicUrl: sequences.musicUrl,
          musicModel: sequences.musicModel,
        })
        .from(sequences)
        .where(eq(sequences.id, sequenceId));
      return row;
    },
  };
}

export function createSequenceMethods(db: Database, sequenceId: string) {
  return {
    ...createSequenceReadMethods(db, sequenceId),

    updateStatus: async (status: SequenceStatus, error?: string | null) => {
      await db
        .update(sequences)
        .set({ status, statusError: error ?? null, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateMusicFields: async (fields: MusicFieldsUpdate) => {
      await db
        .update(sequences)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },
  };
}
