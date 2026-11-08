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
  // ponytail: two concurrent writes can pick the same slug; the unique index refuses the second.
  return uniqueSlug(
    base,
    new Set(rows.filter((row) => row.id !== selfId).map((row) => row.slug))
  );
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
