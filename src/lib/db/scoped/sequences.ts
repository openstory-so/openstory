/**
 * Scoped Sequences Sub-module
 * Team-scoped sequence CRUD and per-sequence update methods.
 */

import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import {
  type AspectRatio,
  DEFAULT_ASPECT_RATIO,
} from '@/lib/constants/aspect-ratios';
import type { Database } from '@/lib/db/client';
import { sequences, shots } from '@/lib/db/schema';
import type { NewSequence, Sequence, Shot, Style } from '@/lib/db/schema';
import type { MusicStatus, SequenceStatus } from '@/lib/db/schema/sequences';
import { ValidationError } from '@/lib/errors';
import { and, asc, desc, eq, inArray, isNull, not } from 'drizzle-orm';

export type MusicFieldsUpdate = {
  musicStatus?: MusicStatus;
  musicModel?: string;
  musicError?: string | null;
  musicUrl?: string;
  musicPath?: string;
  musicGeneratedAt?: Date;
};

type SequenceWithShots = Sequence & {
  shots: Shot[];
  style: Style | null;
};

// D1 caps a single query at 100 bound parameters. `listShotsByIds` binds one
// param per sequence id plus the teamId filter, so each query must stay under
// that ceiling. We chunk the ids well below 100 and union the results; without
// this a team with enough sequences overflows the limit (and previously tripped
// the 500-item request cap on `getShotsForSequencesFn` — see #957).
const SHOTS_BY_IDS_BATCH = 90;

function createSequencesReadMethods(db: Database, teamId: string) {
  return {
    list: async (): Promise<Sequence[]> => {
      return await db
        .select()
        .from(sequences)
        .where(
          and(
            eq(sequences.teamId, teamId),
            not(eq(sequences.status, 'archived'))
          )
        )
        .orderBy(desc(sequences.updatedAt));
    },

    getById: async (sequenceId: string): Promise<Sequence | null> => {
      const result = await db
        .select()
        .from(sequences)
        .where(and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId)));
      return result[0] ?? null;
    },

    getWithFrames: async (
      sequenceId: string
    ): Promise<SequenceWithShots | null> => {
      const result = await db.query.sequences.findFirst({
        where: { id: sequenceId, teamId },
        with: {
          shots: {
            orderBy: { orderIndex: 'asc' },
          },
          style: true,
        },
      });
      if (!result) return null;
      return {
        ...result,
        style: result.style ?? null,
      };
    },

    getForUser: async (params: { sequenceId: string }): Promise<Sequence> => {
      const sequence = await db.query.sequences.findFirst({
        where: { id: params.sequenceId, teamId },
      });
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
    listShotsByIds: async (sequenceIds: string[]): Promise<Shot[]> => {
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
          db
            .select()
            .from(shots)
            .innerJoin(sequences, eq(shots.sequenceId, sequences.id))
            .where(
              and(
                inArray(shots.sequenceId, batch),
                eq(sequences.teamId, teamId)
              )
            )
            .orderBy(asc(shots.sequenceId), asc(shots.orderIndex))
            .then((rows) => rows.map((row) => row.shots))
        )
      );
      return results.flat();
    },
  };
}

export function createSequencesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createSequencesReadMethods(db, teamId),

    create: async (params: {
      title: string;
      script?: string | null;
      styleId: string;
      aspectRatio?: AspectRatio;
      analysisModel: string;
      imageModel?: string;
      videoModel?: string;
      musicModel?: string;
      autoGenerateMotion?: boolean;
      autoGenerateMusic?: boolean;
      suggestedTalentIds?: string[];
      suggestedLocationIds?: string[];
    }): Promise<Sequence> => {
      const sequenceData: NewSequence = {
        teamId,
        createdBy: userId,
        updatedBy: userId,
        title: params.title,
        script: params.script,
        styleId: params.styleId,
        aspectRatio: params.aspectRatio ?? DEFAULT_ASPECT_RATIO,
        analysisModel: params.analysisModel,
        // The sequences SQL column defaults are stale literals ('nano_banana_2'
        // for image, 'kling_v3_pro' for video — see schema/sequences.ts) that
        // can't be changed without a D1 table rebuild, so resolve the app's
        // real default here instead of relying on the column default.
        imageModel: params.imageModel ?? DEFAULT_IMAGE_MODEL,
        videoModel: params.videoModel ?? DEFAULT_VIDEO_MODEL,
        musicModel: params.musicModel,
        autoGenerateMotion: params.autoGenerateMotion ?? false,
        autoGenerateMusic: params.autoGenerateMusic ?? false,
        suggestedTalentIds: params.suggestedTalentIds ?? null,
        suggestedLocationIds: params.suggestedLocationIds ?? null,
        status: 'draft',
      };

      const [data] = await db
        .insert(sequences)
        .values(sequenceData)
        .returning();

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
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

    update: async (params: {
      id: string;
      title?: string;
      script?: string | null;
      styleId?: string;
      status?: SequenceStatus;
      workflowRunId?: string;
      analysisModel?: string;
      aspectRatio?: AspectRatio;
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
    }): Promise<Sequence> => {
      // Scoped by teamId like every other write here — `workflowRunId` in
      // particular is the generation-mutex column (#839), so a cross-team id
      // must never be able to stomp it.
      const { id, ...values } = params;
      const [data] = await db
        .update(sequences)
        .set(values)
        .where(and(eq(sequences.id, id), eq(sequences.teamId, teamId)))
        .returning();

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!data) {
        throw new ValidationError('Sequence not found');
      }

      return data;
    },

    delete: async (sequenceId: string): Promise<void> => {
      await db.delete(sequences).where(eq(sequences.id, sequenceId));
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
