/**
 * Recorded dialogue takes for a scene (#1657). One ElevenLabs Text to
 * Dialogue call records the scene's whole conversation so every turn is
 * acted in context; each shot's clip is a slice of it, cut at the provider's
 * per-turn voice segments. `shots.audioClips` holds the slices (working
 * set); the take is their provenance and the thing a user picks between.
 *
 * `inputHash` is the take key: the ordered lines with their shot ids, the
 * voice id per line, tone, TTS model and stability. A change to any of them
 * makes the selected take stale; a reorder that does not change speaking
 * order moves nothing.
 *
 * Append-only, one selected row per scene, soft-discard via `discardedAt`.
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
import { scenes } from './scenes';
import type { MotionAudioClip } from './shot-prompt-versions';

/** Where one spoken turn sits in the take, and which shot it belongs to. */
export type DialogueTakeSegment = {
  /** Index into the scene's dialogue lines (the version this take spoke). */
  lineIndex: number;
  shotId: string;
  startSeconds: number;
  endSeconds: number;
  /** The wording actually spoken when a fit rewrite shortened this turn. */
  spokenText?: string;
};

export const sceneDialogueTakes = snakeCase.table(
  'scene_dialogue_takes',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sceneId: text()
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    /** The `scene_dialogue_versions` row this take spoke. */
    dialogueVersionId: text().notNull(),
    inputHash: text().notNull(),
    /** The whole recording, WAV in the AUDIO bucket. */
    url: text().notNull(),
    durationSeconds: integer({ mode: 'number' }).notNull(),
    segments: text({ mode: 'json' }).$type<DialogueTakeSegment[]>().notNull(),
    /**
     * The per-shot clips cut from this take, keyed by shot id — what picking
     * this take puts back on `shots.audioClips`. Stored because the slices
     * are the working set: without them, selecting an older take would name
     * a recording whose shot clips no longer exist, and the only way back
     * would be to re-cut the WAV.
     */
    clips: text({ mode: 'json' })
      .$type<Record<string, MotionAudioClip[]>>()
      .notNull(),
    /** TTS characters billed across every attempt. */
    characterCount: integer().notNull(),
    workflowRunId: text(),
    selectedAt: integer({ mode: 'timestamp' }),
    discardedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_scene_dialogue_takes_scene_created').on(
      table.sceneId,
      table.createdAt
    ),
    index('idx_scene_dialogue_takes_scene_hash').on(
      table.sceneId,
      table.inputHash
    ),
    uniqueIndex('uq_scene_dialogue_takes_selected')
      .on(table.sceneId)
      .where(sql`${table.selectedAt} IS NOT NULL`),
  ]
);

export type SceneDialogueTake = InferSelectModel<typeof sceneDialogueTakes>;
