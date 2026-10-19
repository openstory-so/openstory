/**
 * Shared stitches (#2127): a cut shared by `stitch share` or the
 * `create_stitch` MCP tool. The row is the whole cut, with media URLs already
 * pointing at team storage (`stitches/<teamId>/<id>/…`). The page at
 * /stitch/<id> is public: the id is a ULID and is the only credential, like a
 * stored media URL. `publishedAt` is null while the CLI is still uploading
 * the files; the page 404s until the publish call has checked every file is
 * there and every image for a real person. The MCP tool stores through that
 * check first, so its row is born published.
 */

import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import type { StitchCut } from '@/stitches/cut';
import { user } from './auth';
import { teams } from './teams';

export const stitches = snakeCase.table(
  'stitches',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // No cascade (AGENTS.md, D1 table-rebuild trap): cleanup is app code.
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    cut: text({ mode: 'json' }).$type<StitchCut>().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    publishedAt: integer({ mode: 'timestamp' }),
  },
  (table) => [index('idx_stitches_team').on(table.teamId)]
);

export type Stitch = InferSelectModel<typeof stitches>;
