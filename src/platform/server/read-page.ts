import { base64ToBytes, bytesToBase64 } from '@/platform/base64';
import { z } from 'zod';
import { ValidationError } from '@/platform/errors';
import type { PageOptions } from '@/platform/server/db/read-page';

export type PageInput = { limit: number; cursor?: string };
const cursorSchema = z.object({ scope: z.array(z.string()), id: z.string() });

/**
 * Opaque cursor paging over a list read that takes {@link PageOptions}. The
 * cursor is bound to `scope` (collection + filters), so a cursor from one
 * listing cannot continue another. One extra row is fetched to learn whether a
 * next page exists.
 */
export async function readPage<T extends { id: string }>(
  input: PageInput,
  scope: string[],
  load: (page: PageOptions) => Promise<T[]>
) {
  const rows = await load({
    limit: input.limit + 1,
    after: decodeCursor(input.cursor, scope),
  });
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > input.limit && last ? encodeCursor(last.id, scope) : null,
  };
}

/**
 * {@link readPage} loader over rows already in memory — for the small team
 * libraries the app itself loads whole (talent, styles, a talent's sheets).
 */
export const pageRows =
  <T extends { id: string }>(rows: T[]) =>
  (page: PageOptions): Promise<T[]> =>
    Promise.resolve(
      rows
        .filter((row) => !page.after || row.id > page.after)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, page.limit)
    );

/** UTF-8 first: a scope can carry any filter text. */
export const encodeCursorPayload = (value: unknown) =>
  bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
export const decodeCursorPayload = (cursor: string): unknown =>
  JSON.parse(new TextDecoder().decode(base64ToBytes(cursor)));

export const encodeCursor = (id: string, scope: string[]) =>
  encodeCursorPayload({ scope, id });

export function decodeCursor(cursor: string | undefined, scope: string[]) {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.parse(decodeCursorPayload(cursor));
    if (JSON.stringify(parsed.scope) !== JSON.stringify(scope))
      throw new Error('scope');
    return parsed.id;
  } catch {
    throw new ValidationError(
      'Invalid cursor for this collection or filter. Restart listing.'
    );
  }
}
