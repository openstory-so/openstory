/**
 * Character sheet versions (append-only) plus mid-flight divergence parking.
 *
 * Each row is one sheet image — a generated take, an upload, or a snapshot of
 * a pre-versioning primary — of one look of a character (#2015). The live
 * sheet is whichever row the look's `selectedSheetVersionId` points at.
 * Re-rolls accumulate; they never overwrite.
 *
 * `divergedAt IS NOT NULL` still marks a mid-flight output whose inputs moved
 * (the workflow finished against a snapshot that no longer matches live).
 * Those rows are not selected automatically; the user promotes by selecting.
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { characters } from './characters';

const CHARACTER_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type CharacterSheetVariantStatus =
  (typeof CHARACTER_SHEET_VARIANT_STATUSES)[number];

export const characterSheetVariants = snakeCase.table(
  'character_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    characterId: text()
      .notNull()
      // NO ACTION, not cascade or restrict (#2017): a rebuild of `characters`
      // under D1 runs with foreign key checks deferred, where a cascade would
      // delete these rows and a restrict would not stop it. Deletes remove
      // them in app code first (`deleteCharactersStatements`).
      .references(() => characters.id, { onDelete: 'no action' }),
    // The look this sheet draws (#2015). No FK: adding one to an existing
    // table is a rebuild, and no migration has done it. Null only on a row
    // an older worker wrote during the #2015 deploy: it is a sheet of the
    // character's default look.
    lookId: text(),

    model: text({ length: 100 }).notNull(),

    url: text(),
    storagePath: text(),
    // A square portrait drawn from this sheet, for tiles and avatars. Null on
    // rows from before portraits and when the draw failed: tiles then crop
    // the sheet itself.
    portraitUrl: text(),

    status: text()
      .$type<CharacterSheetVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    inputHash: text(),
    // The `character_bible_versions` row the run read (#1600), snapshotted at
    // the trigger. Null on rows from before bible history and on uploads,
    // which read no bible.
    bibleVersionId: text(),
    // The `character_look_versions` row the run read (#2015), snapshotted at
    // the trigger. Null on rows from before looks and on uploads, which read
    // no look.
    lookVersionId: text(),
    divergedAt: integer({ mode: 'timestamp' }),
    // Soft-delete marker; preserves the artifact for the toast Undo.
    discardedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_character_sheet_variants_character').on(table.characterId),
    index('idx_character_sheet_variants_look').on(table.lookId),
    // One parked divergent per (look, model, input hash). History rows
    // (divergedAt IS NULL) are unrestricted so same-input re-rolls accumulate.
    uniqueIndex('character_sheet_variants_look_divergent_key')
      .on(table.lookId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type CharacterSheetVariant = InferSelectModel<
  typeof characterSheetVariants
>;
export type NewCharacterSheetVariant = InferInsertModel<
  typeof characterSheetVariants
>;
