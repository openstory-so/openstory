/**
 * Sequence cast (#2017): which team characters an episode uses.
 *
 * A character belongs to the team. A sequence (an episode) never copies one
 * and never pins a version of one: it holds a cast link, and reads the
 * character's current bible, voice, looks and sheets like every other
 * sequence. The link holds only what is the sequence's: the id the script
 * gave the character, the soft remove, and whether the writer attached it.
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
import { characters } from './characters';
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

export type SequenceCastRow = InferSelectModel<typeof sequenceCast>;
