import { sql, type Column } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Database } from '@/platform/server/db/client';

/** One query per chunk of ids under D1's param cap, sent as one `db.batch()` (#2234); a join must alias its owner id with {@link ownerId}. */
export async function selectInChunks<
  Q extends BatchItem<'sqlite'> & PromiseLike<unknown[]>,
>(
  db: Database,
  ids: readonly string[],
  size: number,
  build: (chunk: string[]) => Q
): Promise<Awaited<Q>> {
  const queries: Q[] = [];
  for (let i = 0; i < ids.length; i += size) {
    queries.push(build(ids.slice(i, i + size)));
  }
  const [first, ...rest] = queries;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- every chunk resolves to the same row array type
  if (!first) return [] as Awaited<Q>;
  if (rest.length === 0) return await first;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- every chunk resolves to the same row array type
  return (await db.batch([first, ...rest])).flat() as Awaited<Q>;
}

/** A joined row's owner id under its own name, so it cannot shadow the version's `id` in a batch. */
export const ownerId = (column: Column) =>
  sql<string>`${column}`.as('owner_id');
