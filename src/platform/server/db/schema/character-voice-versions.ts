/**
 * Voice history for a sequence character (#1657). Completed rows are
 * append-only; an in-flight generated husk (#1715) is completed in place.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { characters, type VoicePreview } from './characters';

/**
 * In-flight Voice Design is a husk on this table (#1715), the stills/video
 * claim: `status: 'generating'`, no voiceId/previews yet, completed in place.
 * Existing rows predate the column and are completed voices. `'pending'` is
 * unused (no queued-not-started phase) but still counts as live so a stray
 * row cannot double-claim.
 */
const CHARACTER_VOICE_VERSION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type CharacterVoiceVersionStatus =
  (typeof CHARACTER_VOICE_VERSION_STATUSES)[number];

/**
 * Why this row exists. Explicit at every call site (#1657) — never inferred
 * from which columns moved, which made a release and a library pick both read
 * as 'generated'. 'removed' is the row written when the character drops its
 * voice id; whether the ElevenLabs slot was actually freed is `releasedAt`.
 */
const CHARACTER_VOICE_VERSION_SOURCES = [
  'analysis',
  'generated',
  'library',
  'user-edit',
  'disabled',
  'removed',
] as const;
export type CharacterVoiceVersionSource =
  (typeof CHARACTER_VOICE_VERSION_SOURCES)[number];

export const characterVoiceVersions = snakeCase.table(
  'character_voice_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    characterId: text()
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    voiceId: text(),
    description: text(),
    previews: text({ mode: 'json' }).$type<VoicePreview[]>(),
    enabled: integer({ mode: 'boolean' }),
    source: text({ enum: CHARACTER_VOICE_VERSION_SOURCES }).notNull(),
    status: text({ enum: CHARACTER_VOICE_VERSION_STATUSES })
      .default('completed')
      .notNull(),
    workflowRunId: text(),
    error: text(),
    /**
     * Set on every row holding a voice id the moment that id is deleted on
     * ElevenLabs (`releaseVoiceIfUnreferenced`). A released row cannot be
     * selected: its id no longer exists at the provider.
     */
    releasedAt: integer({ mode: 'timestamp' }),
    /**
     * The person whose action made this version (picked a library voice, chose
     * a take, recast, turned voice off). Null when nobody did: a row written
     * for a run that carries no user, or the user has since been deleted.
     */
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_character_voice_versions_character_created').on(
      table.characterId,
      table.createdAt
    ),
    // At most one live Voice Design per character (#1715 / #1085).
    uniqueIndex('uq_character_voice_versions_live_claim')
      .on(table.characterId)
      .where(sql`${table.status} IN ('pending', 'generating')`),
  ]
);
