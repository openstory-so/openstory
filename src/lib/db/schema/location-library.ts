/**
 * Location Library Schema
 * Team-level location templates for visual consistency across sequences
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { user } from './auth';
import { teams } from './teams';

/**
 * Location Library table
 * Team-level location templates that can be linked to sequence locations for visual consistency
 */
export const locationLibrary = snakeCase.table(
  'location_library',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    description: text(),
    // Reference image (establishing shot / mood board)
    referenceImageUrl: text(),
    referenceImagePath: text(), // R2 storage path
    isPublic: integer({ mode: 'boolean' }).default(false),
    isTemplate: integer({ mode: 'boolean' }).default(false),
    referenceInputHash: text(),
    // Tracking
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_location_library_team_id').on(table.teamId),
    index('idx_location_library_name').on(table.name),
  ]
);

// Type exports
export type LibraryLocation = InferSelectModel<typeof locationLibrary>;
export type NewLibraryLocation = InferInsertModel<typeof locationLibrary>;
