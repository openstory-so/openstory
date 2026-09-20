/** Append-only voice history for a sequence character (#1657). */
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { characters, type VoicePreview } from './characters';

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
    /**
     * Set on every row holding a voice id the moment that id is deleted on
     * ElevenLabs (`releaseVoiceIfUnreferenced`). A released row cannot be
     * selected: its id no longer exists at the provider.
     */
    releasedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_character_voice_versions_character_created').on(
      table.characterId,
      table.createdAt
    ),
  ]
);
