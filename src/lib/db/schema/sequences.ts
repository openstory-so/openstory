/**
 * Sequences Schema
 * Core content creation entities for video sequences
 */

import {
  type AspectRatio,
  DEFAULT_ASPECT_RATIO,
} from '@/lib/constants/aspect-ratios';
import type { Resolution } from '@/lib/constants/resolutions';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
// NOTE: shots imported in index.ts to avoid circular dependency
// shots.ts imports sequences for foreign key reference
import { styles } from './libraries';
import { teams } from './teams';
import type { StoredStyleConfig } from '@/lib/style/style-config';

// Enum values as constants (SQLite doesn't have native enums)
const SEQUENCE_STATUSES = [
  'draft',
  'processing',
  'completed',
  'failed',
  'archived',
] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

const MUSIC_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type MusicStatus = (typeof MUSIC_STATUSES)[number];

/**
 * Sequences table
 * Main video sequence/project entity
 */
export const sequences = snakeCase.table(
  'sequences',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    title: text({ length: 500 }).notNull(),
    script: text(),
    // used to track the status of the sequence
    status: text().$type<SequenceStatus>().default('draft').notNull(),
    statusError: text(),
    // CF Workflows instance id of the most recent /storyboard run. Lets the
    // cron reconciler (reconcile-all.ts) verify a stuck 'processing' row
    // against the instance's real status instead of leaving it spinning
    // forever when the workflow dies without persisting an outcome (#839).
    workflowRunId: text({ length: 100 }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    updatedBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    styleId: text()
      .notNull()
      .references(() => styles.id, { onDelete: 'set null' }),
    // Recipe this sequence was generated with. Copied from styles.config on
    // create / style change so catalog edits cannot stale existing work.
    // Nullable only for the ADD COLUMN + backfill window; new writes always set it.
    styleConfig: text({ mode: 'json' }).$type<StoredStyleConfig>(),
    aspectRatio: text({ length: 10 })
      .$type<AspectRatio>()
      .default(DEFAULT_ASPECT_RATIO)
      .notNull(),
    // Output resolution tier every generation in this sequence is asked for
    // (#1449). SQL default pinned to the literal '720p' to match the deployed
    // column default — DEFAULT_RESOLUTION must NOT be written here: SQLite
    // can't ALTER a column default without a full table rebuild, which
    // CASCADE-deletes child rows on D1 (#612).
    resolution: text({ length: 10 })
      .$type<Resolution>()
      .default('720p')
      .notNull(),

    // SQL default pinned to the literal 'anthropic/claude-haiku-4.5' to match
    // every deployed DB's column default. DEFAULT_ANALYSIS_MODEL (see
    // models.config.ts) must NOT be written here: SQLite can't ALTER a
    // column default without a full table rebuild, which CASCADE-deletes
    // child rows on D1 (#612). The scoped create (db/scoped/sequences.ts)
    // substitutes DEFAULT_ANALYSIS_MODEL for an omitted analysisModel,
    // mirroring imageModel / videoModel below.
    analysisModel: text({ length: 100 })
      .default('anthropic/claude-haiku-4.5')
      .notNull(),
    analysisDurationMs: integer().default(0).notNull(),
    // SQL default pinned to the literal 'nano_banana_2' to match every deployed
    // DB's column default. DEFAULT_IMAGE_MODEL was bumped to 'gpt_image_2'
    // WITHOUT a migration; SQLite can't ALTER a column default without a full
    // table rebuild, which CASCADE-deletes child rows on D1 (#612). The scoped
    // create (db/scoped/sequences.ts) substitutes DEFAULT_IMAGE_MODEL for an
    // omitted imageModel, mirroring videoModel below.
    imageModel: text({ length: 100 }).default('nano_banana_2').notNull(),
    // SQL default is pinned to 'kling_v3_pro' to match every deployed DB's
    // column default (#801 changed DEFAULT_VIDEO_MODEL to grok WITHOUT a
    // migration; SQLite can't ALTER a column default without a full table
    // rebuild, which CASCADE-deletes child rows on D1 — see CLAUDE.md). So
    // db:generate stays clean. The app must NOT rely on this default: the
    // scoped create (db/scoped/sequences.ts) substitutes DEFAULT_VIDEO_MODEL
    // for an omitted videoModel, and create-sequences always passes the
    // user's resolved selection. drizzle inlines `.default()` and ignores
    // `$defaultFn` when both are set, so an app-level grok default can't live
    // here.
    videoModel: text({ length: 100 }).default('kling_v3_pro').notNull(),
    workflow: text({ length: 100 }),

    // TB-20260804: DB-Audit: music* should not be stored on the sequence directly and instead should point to a variant / version table
    // Music track fields (sequence-level background music)
    musicUrl: text(),
    musicPath: text(),
    musicStatus: text().$type<MusicStatus>().default('pending'),
    musicGeneratedAt: integer({
      mode: 'timestamp',
    }),
    musicError: text(),
    musicModel: text({ length: 100 }),
    musicPrompt: text(),
    musicTags: text(),
    // SHA-256 of the upstream context that produced the cached AI music
    // prompt (musicDesign + analysis model). Null when no AI prompt has been
    // generated yet, or when the most recent variant was a user-edit.
    musicPromptInputHash: text(),
    // Whether the sequence's background music is included in theatre playback
    // and MP4 export. Default on (mirrors the old #687 "Include music in merged
    // video" checkbox). Toggling it off mutes only the music track — scene and
    // dialogue audio are unaffected (#834).
    includeMusic: integer({ mode: 'boolean' }).default(true).notNull(),

    // Poster image (sequence-level preview generated from the script). Stored
    // in R2 as an origin-relative `/r2/` URL (#1117, #894) — rows written
    // before that fix hold a provider CDN URL that may have expired, and fall
    // back to the player's empty state until the sequence regenerates.
    posterUrl: text(),

    // Dedup for the "your video is ready" email (#1276). Conceptual key is
    // `${sequenceId}:ready` — claimed with a CAS write so workflow step
    // retries and smart-retry re-completes cannot double-send.
    readyEmailSentAt: integer({ mode: 'timestamp' }),

    // Sequence default for "does a shot animate from a rendered still"
    // (`shots.useStartFrame` overrides it per shot, NULL = inherit; resolve
    // with `usesStartFrame()`, never raw). Off by default: a new sequence
    // renders reference-only, straight to video from the cast / location /
    // element sheets, and this is the opt-in back to the frame-based
    // workflow. Replaced the inverted `referenceOnly` (ADD COLUMN + backfill +
    // DROP COLUMN, no rebuild, #612). Set at creation and never toggled
    // after (`updateSequenceSchema` omits it): the storyboard trigger
    // snapshots it onto the workflow payload,
    // and every stored motion prompt's input hash folds the resolved mode in,
    // so flipping it re-stales the prompts rather than mixing two styles.
    generateStartFrames: integer({ mode: 'boolean' }).default(false).notNull(),

    // Auto-generation flags (set at sequence creation, read by UI for phase display)
    // TB-20260804: DB-Audit: autoGenerateMotion and autoGenerateMusic should not be stored. They should be set when the workflow is initiated.
    autoGenerateMotion: integer({ mode: 'boolean' }).default(false).notNull(),
    autoGenerateMusic: integer({ mode: 'boolean' }).default(false).notNull(),

    // Suggested talent/location IDs used during generation (for pre-populating the UI)
    suggestedTalentIds: text({
      mode: 'json',
    }).$type<string[]>(),
    suggestedLocationIds: text({
      mode: 'json',
    }).$type<string[]>(),
  },
  (table) => [
    index('idx_sequences_created_at').on(table.createdAt),
    index('idx_sequences_status').on(table.status),
    index('idx_sequences_style_id').on(table.styleId),
    index('idx_sequences_team_id').on(table.teamId),
  ]
);

// Type exports
export type Sequence = InferSelectModel<typeof sequences>;
export type NewSequence = InferInsertModel<typeof sequences>;
