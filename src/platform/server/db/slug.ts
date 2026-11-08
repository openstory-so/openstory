import { and, eq, like, or } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import {
  characters,
  locations,
  sequences,
  styles,
} from '@/platform/server/db/schema';
import { isValidId } from '@/platform/id';
import { slugify, uniqueSlug } from '@/platform/slug';

type SluggedTable =
  | typeof sequences
  | typeof characters
  | typeof locations
  | typeof styles;

/**
 * A free slug for `name` in the organization. A rename (`selfId`) keeps its
 * own slug while the name still slugifies to the same base.
 */
export async function freeSlug(
  db: Database,
  table: SluggedTable,
  organizationId: string,
  name: string,
  selfId?: string
): Promise<string> {
  const base = slugify(name);
  // Slugs are [a-z0-9-], so LIKE has no wildcard to escape.
  const rows: { id: string; slug: string }[] = await db
    .select({ id: table.id, slug: table.slug })
    .from(table)
    .where(
      and(
        eq(table.organizationId, organizationId),
        or(eq(table.slug, base), like(table.slug, `${base}-%`))
      )
    );
  const own = rows.find((row) => row.id === selfId)?.slug;
  if (own !== undefined && /^(-\d+)?$/.test(own.slice(base.length))) {
    return own;
  }
  // Two concurrent writes can pick the same slug: callers go through retryOnSlugClash.
  return uniqueSlug(
    base,
    new Set(rows.filter((row) => row.id !== selfId).map((row) => row.slug))
  );
}

const SLUG_CLASH_RE =
  /UNIQUE constraint failed: \w+\.organization_id, \w+\.slug/;
const SLUG_ATTEMPTS = 5;

/** A write lost a slug to a concurrent one; D1 says so only in the message, which drizzle wraps. */
function isSlugClash(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (SLUG_CLASH_RE.test(e.message)) return true;
  }
  return false;
}

/**
 * Runs `write` again while a concurrent write takes the slug it picked.
 * `write` must pick its slug with freeSlug and land in one statement or batch.
 */
export function retryOnSlugClash<A extends unknown[], R>(
  write: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await write(...args);
      } catch (error) {
        if (attempt >= SLUG_ATTEMPTS || !isSlugClash(error)) throw error;
      }
    }
  };
}

/** The ULID a route param names: a ULID passes through, a slug is looked up in the organization. */
export async function resolveSlugOrId(
  db: Database,
  table: SluggedTable,
  organizationId: string,
  idOrSlug: string
): Promise<string | null> {
  if (isValidId(idOrSlug)) return idOrSlug;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(eq(table.organizationId, organizationId), eq(table.slug, idOrSlug))
    )
    .limit(1);
  return row?.id ?? null;
}
