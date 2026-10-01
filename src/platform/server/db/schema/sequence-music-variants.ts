/**
 * Sequence Music Variants Schema
 *
 * Append-only music tracks (#1115): every generation, upload and add-model run
 * is its own row, opened `pending` before anything is spent and landed in
 * place. The sequence plays whichever row `sequences.selectedMusicVariantId`
 * points at; a primary run reaches that pointer only through the claim
 * `sequences.pendingPromoteMusicVariantId`. The newest `isPrimary` row's
 * lifecycle IS the sequence's music status.
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { index, integer, real, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { sequences } from './sequences';

// Music is generated, not merged — no 'merging' status (which is video-only).
const SEQUENCE_MUSIC_VARIANT_STATUSES = [
  'pending',
  'completed',
  'failed',
] as const;
export type SequenceMusicVariantStatus =
  (typeof SEQUENCE_MUSIC_VARIANT_STATUSES)[number];

export const sequenceMusicVariants = snakeCase.table(
  'sequence_music_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    // Output
    url: text(),
    storagePath: text(),
    // Measured integrated loudness gain in dB needed to hit the target
    // listening level (see DEFAULT_MUSIC_LOUDNESS_LUFS). Computed once at
    // music-generation time so the live player can apply a single GainNode
    // without re-running an EBU R128 pass per playback. Nullable for rows
    // generated before the measurement step shipped — the player falls back
    // to a fixed default gain in that case.
    loudnessGainDb: real(),

    // Inputs that produced this variant (kept on the row for promotion)
    prompt: text(),
    tags: text(),
    durationSeconds: integer(),
    model: text({ length: 100 }).notNull(),

    // Generation tracking
    status: text()
      .$type<SequenceMusicVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    // A primary track run (the sequence's own generation, a regeneration, an
    // upload) — its lifecycle is the sequence's music status. False for an
    // added audio model's track (#547), which never touches the pointer.
    isPrimary: integer({ mode: 'boolean' }).default(true).notNull(),

    // Staleness detection
    inputHash: text(),
    // Set when a primary run completed after its claim had moved (a newer
    // run, or the user's pick): the track is parked, offered by the banner.
    divergedAt: integer({ mode: 'timestamp' }),
    // Soft-delete marker for divergent alternates the user has dismissed.
    // Mirrors `shot_variants.discarded_at` so the toast Undo flow can clear
    // the row without losing the artifact.
    discardedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_sequence_music_variants_sequence').on(table.sequenceId),
  ]
);

export type SequenceMusicVariant = InferSelectModel<
  typeof sequenceMusicVariants
>;
export type NewSequenceMusicVariant = InferInsertModel<
  typeof sequenceMusicVariants
>;
