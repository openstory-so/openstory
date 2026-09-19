/**
 * Scoped Sequence Music Prompt Versions Sub-module
 *
 * Appends a new revision row to `sequence_music_prompt_versions` and
 * updates the cached `musicPrompt` / `musicTags` / `musicPromptInputHash`
 * columns on `sequences`. Sequential, not transactional — see the
 * equivalent docstring in `shot-prompt-versions.ts` for the durability
 * story. Renamed from `sequence-music-prompt-variants` in #988.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type { Database } from '@/platform/server/db/client';
import {
  sequenceMusicPromptVersions,
  sequences,
  user,
} from '@/platform/server/db/schema';
import type { SequenceMusicPromptVersion } from '@/platform/server/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';
import type { MusicPromptInputHash } from '@/shots/input-hash';

type WriteSequenceMusicPromptVersionBase = {
  sequenceId: string;
  prompt: string;
  tags?: string | null;
  createdBy?: string | null;
};

/**
 * AI-generated and regenerated rows must carry the upstream-context hash and
 * the analysis model that produced the prompt — without these, the cached
 * `musicPromptInputHash` column on `sequences` is meaningless and staleness
 * detection silently breaks. User-edits forbid both fields so they cannot be
 * set by mistake.
 *
 * Restored rows carry the source version's hash + analysisModel verbatim so
 * the cached `musicPromptInputHash` column keeps tracking the upstream
 * context that originally produced the prompt — restoring an old AI prompt
 * must NOT silently disable staleness detection. Both fields can be null
 * when the source is itself a user-edit (which never had a hash).
 */
export type WriteSequenceMusicPromptVersionInput =
  WriteSequenceMusicPromptVersionBase &
    (
      | {
          source: 'ai-generated' | 'regenerated';
          inputHash: MusicPromptInputHash;
          analysisModel: string;
        }
      | {
          source: 'user-edit';
          inputHash?: never;
          analysisModel?: never;
        }
      | {
          source: 'restored';
          inputHash: string | null;
          analysisModel: string | null;
        }
    );

export function createSequenceMusicPromptVersionsMethods(db: Database) {
  return {
    /**
     * Append a music prompt version row and update the cached
     * `musicPrompt` / `musicTags` / `musicPromptInputHash` columns on
     * `sequences`. Returns the inserted (or pre-existing matching) row.
     *
     * AI-generated rows are deduped on a unique partial index
     * `(sequence_id, input_hash) WHERE input_hash IS NOT NULL AND
     * source != 'restored'` so workflow retries don't append duplicate history
     * (the `source != 'restored'` clause lets a restore still append an audit
     * row even when its hash matches an existing one).
     */
    write: async (
      input: WriteSequenceMusicPromptVersionInput
    ): Promise<SequenceMusicPromptVersion> => {
      const nextHash = input.source === 'user-edit' ? null : input.inputHash;
      const analysisModel =
        input.source === 'user-edit' ? null : input.analysisModel;

      const [inserted] = await db
        .insert(sequenceMusicPromptVersions)
        .values({
          sequenceId: input.sequenceId,
          prompt: input.prompt,
          tags: input.tags ?? null,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let version: SequenceMusicPromptVersion | undefined = inserted;
      if (!version && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(sequenceMusicPromptVersions)
          .where(
            and(
              eq(sequenceMusicPromptVersions.sequenceId, input.sequenceId),
              eq(sequenceMusicPromptVersions.inputHash, nextHash)
            )
          )
          .limit(1);
        version = existing;
      }

      if (!version) {
        throw new Error('Failed to insert sequence music prompt version');
      }

      await db
        .update(sequences)
        .set({
          musicPrompt: input.prompt,
          musicTags: input.tags ?? null,
          musicPromptInputHash: nextHash,
          updatedAt: new Date(),
        })
        .where(eq(sequences.id, input.sequenceId));

      return version;
    },

    /** Revision history for a sequence's music prompt, newest first. */
    listBySequence: async (
      sequenceId: string,
      page?: PageOptions
    ): Promise<SequenceMusicPromptVersion[]> => {
      return await pageOf(
        db.select().from(sequenceMusicPromptVersions).$dynamic(),
        eq(sequenceMusicPromptVersions.sequenceId, sequenceId),
        sequenceMusicPromptVersions.id,
        page,
        desc(sequenceMusicPromptVersions.createdAt)
      );
    },

    /** Most recent music prompt version, or null if none exists. */
    getLatest: async (
      sequenceId: string
    ): Promise<SequenceMusicPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(sequenceMusicPromptVersions)
        .where(eq(sequenceMusicPromptVersions.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /** History list for the UI — joins author name. Newest first. */
    listBySequenceWithAuthor: async (
      sequenceId: string
    ): Promise<
      Array<SequenceMusicPromptVersion & { createdByName: string | null }>
    > => {
      const rows = await db
        .select({
          version: sequenceMusicPromptVersions,
          createdByName: user.name,
        })
        .from(sequenceMusicPromptVersions)
        .leftJoin(user, eq(sequenceMusicPromptVersions.createdBy, user.id))
        .where(eq(sequenceMusicPromptVersions.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVersions.createdAt));
      return rows.map((r) => ({
        ...r.version,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single music prompt version scoped to its sequence. */
    getByIdForSequence: async (
      versionId: string,
      sequenceId: string
    ): Promise<SequenceMusicPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(sequenceMusicPromptVersions)
        .where(
          and(
            eq(sequenceMusicPromptVersions.id, versionId),
            eq(sequenceMusicPromptVersions.sequenceId, sequenceId)
          )
        )
        .limit(1);
      return row ?? null;
    },
  };
}
