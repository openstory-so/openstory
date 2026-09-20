/**
 * In-flight dialogue recordings, one claim per shot about to take new audio
 * (#1657) — the same lifecycle every other generation has (#1085, see
 * `frame_prompt_versions`), in its own table because a reading cannot be its
 * own placeholder: a `shot_dialogue_sections` row needs a recording and a
 * time range, and neither exists until the call returns.
 *
 * - **Claim.** The recorder inserts a `generating` row per adopting shot
 *   before it spends anything. The live unique index makes a second run for
 *   the same shot and the same words stand down instead of recording twice.
 * - **Demote.** `pendingSourceKey` is the live key. Anything the user does
 *   that should win — picking a reading, changing or restoring the lines —
 *   nulls it. The run still finishes; it just no longer holds the right to
 *   become the shot's audio.
 * - **Complete.** The persist step promotes a reading (selects its section
 *   AND writes `shots.audioClips`, one batch) only for a claim that is still
 *   live. A demoted or cancelled claim's reading is kept, unselected.
 * - **Fail.** The recorder fails its own claims; the 5-minute reconcile sweep
 *   fails the claims of a run that died.
 */
import { sql, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { shots } from './shots';

const SHOT_DIALOGUE_CLAIM_STATUSES = [
  'generating',
  'completed',
  'failed',
  'cancelled',
] as const;
export const shotDialogueClaims = snakeCase.table(
  'shot_dialogue_claims',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    /** `dialogueClipSourceKey` of the words and voices being recorded. */
    sourceKey: text().notNull(),
    /** `sourceKey` while the claim may still become the shot's audio; null once demoted. */
    pendingSourceKey: text(),
    status: text({ enum: SHOT_DIALOGUE_CLAIM_STATUSES }).notNull(),
    /** The reading this claim produced, set at completion. */
    sectionId: text(),
    /** Set when the reading was promoted to the shot's audio; null = kept unselected. */
    promotedAt: integer({ mode: 'timestamp' }),
    error: text(),
    workflowRunId: text().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_shot_dialogue_claims_shot_created').on(
      table.shotId,
      table.createdAt
    ),
    index('idx_shot_dialogue_claims_status_created').on(
      table.status,
      table.createdAt
    ),
    // At most ONE live claim per (shot, words+voices): the race between two
    // runs that both found the shot without a matching clip.
    uniqueIndex('uq_shot_dialogue_claims_live')
      .on(table.shotId, table.pendingSourceKey)
      .where(
        sql`${table.pendingSourceKey} IS NOT NULL AND ${table.status} = 'generating'`
      ),
  ]
);

export type ShotDialogueClaim = InferSelectModel<typeof shotDialogueClaims>;
