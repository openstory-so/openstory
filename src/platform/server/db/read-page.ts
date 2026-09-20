import { and, asc, gt } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import type { SQLiteSelect } from 'drizzle-orm/sqlite-core';

/**
 * Opt-in id-cursor paging for an existing list read. `after` is the last id of
 * the previous page; ULIDs sort by creation, so id order is oldest-first.
 */
export type PageOptions = { limit: number; after?: string | null };

/** Options every version-history list read takes. */
export type VersionListOptions = {
  includeDiscarded?: boolean;
  page?: PageOptions;
};

/**
 * Finish a `$dynamic()` list query. Unpaged callers (the editor) keep the
 * method's own ordering; a paged caller gets `id > after ORDER BY id LIMIT n`.
 */
export function pageOf<T extends SQLiteSelect>(
  query: T,
  where: SQL | undefined,
  id: AnyColumn,
  page: PageOptions | undefined,
  ...defaultOrder: (SQL | AnyColumn)[]
) {
  if (!page) {
    const all = query.where(where);
    return defaultOrder.length ? all.orderBy(...defaultOrder) : all;
  }
  return query
    .where(and(where, page.after ? gt(id, page.after) : undefined))
    .orderBy(asc(id))
    .limit(page.limit);
}
