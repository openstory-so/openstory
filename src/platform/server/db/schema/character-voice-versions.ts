/** Append-only voice history for a sequence character (#1657). */
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
 * Why this row exists. Explicit at every call site (#1657) — never inferred
 * from which columns moved, which made a release and a library pick both read
 * as 'generated'. 'released' is the row written when the voice id is dropped
 * because its ElevenLabs slot was freed.
 */
const CHARACTER_VOICE_VERSION_SOURCES = [
  'analysis',
  'generated',
  'library',
  'user-edit',
  'disabled',
  'released',
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
    source: text().$type<CharacterVoiceVersionSource>().notNull(),
    selectedAt: integer({ mode: 'timestamp' }),
    /**
     * Set on every row holding a voice id the moment that id is deleted on
     * ElevenLabs (`releaseVoiceIfUnreferenced`). A released row cannot be
     * selected: its id no longer exists at the provider.
     */
    releasedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_character_voice_versions_character_created').on(
      table.characterId,
      table.createdAt
    ),
    uniqueIndex('uq_character_voice_versions_selected')
      .on(table.characterId)
      .where(sql`${table.selectedAt} IS NOT NULL`),
  ]
);
