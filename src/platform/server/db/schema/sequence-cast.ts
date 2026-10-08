/**
 * Sequence cast (#2017): which team characters an episode uses, and at which
 * version.
 *
 * A character belongs to the team. A sequence (an episode) never copies one:
 * it holds a cast link that pins the bible version it uses, and one cast look
 * per look it uses, pinning the look version and holding that episode's sheet
 * pointer and sheet claim. Everything a sequence decides about a character
 * lives on these two tables; the character and the look keep only identity
 * and their current version.
 */

import type { InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { characterLooks } from './character-looks';
import { characters, type SheetStatus } from './characters';
import { sequences } from './sequences';

/** One character in one sequence. */
export const sequenceCast = snakeCase.table(
  'sequence_cast',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // RESTRICT, not cascade: a sequence delete removes its links in app code
    // (the #612 rebuild trap).
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'restrict' }),
    characterId: text()
      .notNull()
      .references(() => characters.id, { onDelete: 'restrict' }),
    // The id script analysis gave the character in this sequence, e.g.
    // "char_001". Scene character tags resolve through it.
    scriptCharacterId: text().notNull(),
    // The `character_bible_versions` row this sequence uses. No FK, like the
    // character's own pointer. The cast talent is that version's `talentId`.
    bibleVersionId: text().notNull(),
    // The `character_voice_versions` row this sequence speaks in (#2017, PR
    // 3). No FK, like the character's own pointer. Null when the character
    // has no voice here: a legitimate state, not an unknown. A voice write
    // made from a sequence moves this and the character's current pointer;
    // the other sequences keep what they pinned, and a provider voice is held
    // while any live link pins a version naming it.
    voiceVersionId: text(),
    // Soft-remove from the sequence, undoable. The character itself stays.
    removedAt: integer({ mode: 'timestamp' }),
    // The writer picked this character for the sequence (`characters.attach`,
    // #2065) rather than analysis making it here. Analysis never rewrites an
    // attached character, even when no other sequence has cast it.
    attached: integer({ mode: 'boolean' }).default(false).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('sequence_cast_sequence_character_key').on(
      table.sequenceId,
      table.characterId
    ),
    uniqueIndex('sequence_cast_sequence_script_character_key').on(
      table.sequenceId,
      table.scriptCharacterId
    ),
    index('idx_sequence_cast_character').on(table.characterId),
  ]
);

/** One look of a cast character, as one sequence uses it. */
export const sequenceCastLooks = snakeCase.table(
  'sequence_cast_looks',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    castId: text()
      .notNull()
      .references(() => sequenceCast.id, { onDelete: 'restrict' }),
    lookId: text()
      .notNull()
      .references(() => characterLooks.id, { onDelete: 'restrict' }),
    // The `character_look_versions` row this sequence uses. No FK.
    lookVersionId: text().notNull(),
    // The live `character_sheet_variants` row. No FK. A sheet also depends on
    // the sequence's style and image model, so the pointer is per sequence.
    // Null until a sheet lands — and on a default look whose sheet is the
    // pre-#1419 row keyed to the character's own id.
    selectedSheetVersionId: text(),
    // The sheet claim (#1113, #1130): the id the in-flight run's version row
    // will carry. Cleared by every write that changes a sheet input or picks
    // a sheet. Null when no run holds the pointer.
    pendingPromoteSheetVersionId: text(),
    // Lifecycle before any sheet row exists (#1419).
    sheetStatus: text().$type<SheetStatus>().notNull(),
    sheetError: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('sequence_cast_looks_cast_look_key').on(
      table.castId,
      table.lookId
    ),
    index('idx_sequence_cast_looks_look').on(table.lookId),
  ]
);

export type SequenceCastRow = InferSelectModel<typeof sequenceCast>;
export type SequenceCastLookRow = InferSelectModel<typeof sequenceCastLooks>;
