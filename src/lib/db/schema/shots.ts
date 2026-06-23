/**
 * Shots Schema
 * Individual shots within a sequence — the unit of VIDEO (a continuous take).
 *
 * Each shot carries the motion prompt, the rendered video/audio, and the Scene
 * analysis data (`metadata`). The shot's still keyframe(s) — the image surface —
 * live in the `frames` table (a shot owns 1..N frames), and motion is generated
 * from the shot's primary frame. See #911 scene/shot/frame split.
 *
 * @see src/lib/db/schema/frames.ts for the per-shot still keyframes
 * @see src/lib/ai/scene-analysis.schema.ts for the Scene metadata structure
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { scenes } from './scenes';
import { sequences } from './sequences';

export const FRAME_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
type FrameGenerationStatus = (typeof FRAME_GENERATION_STATUSES)[number];

/**
 * Shots table
 * Individual shots within a sequence. Each shot represents one shot from script
 * analysis and stores motion/video/audio artifacts plus Scene data in
 * `metadata` (populated progressively across analysis phases). The image
 * surface lives in `frames`.
 */
export const shots = snakeCase.table(
  'shots',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Parent scene (#907). NULL until backfilled. Deliberately NOT cascade —
    // CLAUDE.md rule 3: never cascade to long-lived parents; orphaned shots
    // null out rather than vanish if a scene is deleted.
    sceneId: text().references(() => scenes.id, { onDelete: 'set null' }),
    // 1-based shot order within the scene. Backfill sets this to 1 (every
    // sequence becomes scenes-of-one-shot until multi-shot analysis lands).
    shotNumber: integer(),
    orderIndex: integer().notNull(),
    description: text(),
    durationMs: integer().default(3000),
    // Video/motion artifact.
    videoUrl: text(),
    videoPath: text(), // R2 storage path (not signed URL)
    videoStatus: text().$type<FrameGenerationStatus>().default('pending'),
    videoWorkflowRunId: text(),
    videoGeneratedAt: integer({
      mode: 'timestamp',
    }),
    videoError: text(),
    motionPrompt: text(), // Mirror of the selected motion-prompt version's text (read-path convenience)
    // Soft pointer → shot_prompt_versions.id (plain column, no FK — versions are
    // soft-deleted; repointed in app code). Selecting/reverting = repoint.
    selectedMotionPromptVersionId: text(),
    motionModel: text({ length: 100 }), // Model used for motion/video generation (nullable - inherits from sequence if not set)
    // Audio/music generation status tracking
    audioUrl: text(),
    audioPath: text(), // R2 storage path (not signed URL)
    audioStatus: text().$type<FrameGenerationStatus>().default('pending'),
    audioWorkflowRunId: text(),
    audioGeneratedAt: integer({
      mode: 'timestamp',
    }),
    audioError: text(),
    audioModel: text({ length: 100 }), // Model used for music/audio generation (nullable)
    // SHA-256 of the inputs that produced each artifact; null when the
    // artifact has never been generated. See
    // docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
    videoInputHash: text(),
    audioInputHash: text(),
    // SHA-256 of the upstream context that produced the cached motion prompt.
    // When upstream context changes, the prompt is flagged stale independently
    // of the rendered video. Null when no AI prompt has been generated yet, or
    // when the most recent variant was a user-edit.
    motionPromptInputHash: text(),
    /**
     * Stores Scene data at various stages of progressive analysis.
     * Fields are populated progressively across analysis phases.
     * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
     */
    metadata: text({ mode: 'json' }).$type<Scene>(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Compound index for efficient ordering queries
    index('idx_shots_order').on(table.sequenceId, table.orderIndex),
    index('idx_shots_sequence_id').on(table.sequenceId),
    // Unique constraint: one shot per sequence/order combination
    uniqueIndex('shots_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

// Override the inferred Shot type to use Scene for metadata
type InferredShot = InferSelectModel<typeof shots>;
export type Shot = Omit<InferredShot, 'metadata'> & {
  metadata: Scene | null; // Nullable until script analysis completes, fields populate progressively
};

type InferredNewShot = InferInsertModel<typeof shots>;
export type NewShot = Omit<InferredNewShot, 'metadata'> & {
  metadata?: Scene | null; // Optional - can be null initially, populated during script analysis
};
