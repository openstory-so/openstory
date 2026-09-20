/**
 * Recorded dialogue (#1657): one row per ElevenLabs Text to Dialogue call,
 * holding the whole file exactly as the provider returned it. A call speaks a
 * conversation — a shot's lines plus the neighbours that make the acting
 * good — and each shot it spoke points at a time range of it through
 * `shot_dialogue_sections`.
 *
 * Append-only and never joined or concatenated. There is NO selected flag and
 * NO per-shot copy here: selection is per shot, on the section rows, so a new
 * recording only moves the shots that adopt it.
 *
 * `inputHash` is `recordingKey`: the ordered turns with their shot ids, the
 * words, the voice id per turn, tone, TTS model and stability.
 */
import { sql, type InferSelectModel } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  snakeCase,
  text,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { sequences } from './sequences';

/** Where one spoken turn sits in the recording, and which shot it belongs to. */
export type DialogueRecordingTurn = {
  shotId: string;
  /** Index into THAT SHOT's dialogue lines. */
  index: number;
  /** The ElevenLabs voice that spoke this turn. */
  voiceId: string;
  /** The TTS model the call ran on. */
  ttsModel: string;
  startSeconds: number;
  endSeconds: number;
  /** The wording actually spoken when a fit rewrite shortened this turn. */
  spokenText?: string;
};

export const dialogueRecordings = snakeCase.table(
  'dialogue_recordings',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    /** `<bucket>/<path>` of the whole WAV — what `cutAudioSection` ranges into. */
    storageKey: text().notNull(),
    url: text().notNull(),
    durationSeconds: real().notNull(),
    turns: text({ mode: 'json' }).$type<DialogueRecordingTurn[]>().notNull(),
    inputHash: text().notNull(),
    /** TTS characters billed for this call. */
    characterCount: integer().notNull(),
    workflowRunId: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_dialogue_recordings_sequence_created').on(
      table.sequenceId,
      table.createdAt
    ),
    check('dialogue_recordings_duration', sql`${table.durationSeconds} > 0`),
  ]
);

export type DialogueRecording = InferSelectModel<typeof dialogueRecordings>;
