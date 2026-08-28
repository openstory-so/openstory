/**
 * Scoped Styles Sub-module
 * Team-scoped style library CRUD (includes public styles in listing).
 */

import type { Database } from '@/lib/db/client';
import type { NewStyle, Style } from '@/lib/db/schema';
import { styles } from '@/lib/db/schema';
import { ConflictError, ValidationError } from '@/lib/errors';
import {
  SERVER_MANAGED_STYLE_COLUMNS,
  type ServerManagedStyleColumn,
} from '@/lib/schemas/style.schemas';
import { stripServerManagedColumns } from './server-managed';
import { styleSlug } from '@/lib/style/style-slug';
import type { AutoStyleDraft } from '@/lib/style/auto-style';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'db', 'styles']);

// `listByIds` chunks its id list per query. It binds only id params (no team
// filter), so it could go to D1's 100-bound-parameter ceiling; we hold it at 90
// to match the sibling sequences.listShotsByIds batch size.
const STYLES_BY_IDS_BATCH = 90;

type StylesListOptions = {
  orderBy?: 'popular' | 'sortOrder';
};

function boundRowsOwnedBy(teamId: string) {
  return or(isNull(styles.sequenceId), eq(styles.teamId, teamId));
}

/** The team's library: own + public rows, never a sequence-bound one. */
function libraryVisibleTo(teamId: string) {
  return and(
    or(eq(styles.teamId, teamId), eq(styles.isPublic, true)),
    isNull(styles.sequenceId)
  );
}

/**
 * A style's URL/asset slug is derived from its name (`styleSlug`) and is the key
 * the `?style=<slug>` composer prefill (and every style asset path) resolves on.
 * A team only ever sees its own styles plus public ones, so the slug must be
 * unique within that union — otherwise a slug would be ambiguous for that
 * account. Enforced here (no DB constraint can express "unique across this team
 * ∪ all public") on create + rename. `excludeId` skips the row being renamed.
 *
 * This guards against the future where teams can author styles; public styles
 * are seeded with already-unique names.
 *
 * Sequence-bound (automatic) styles are outside the library, so they neither
 * need a unique slug nor count as a clash — until promotion, which checks here.
 */
async function assertSlugAvailable(
  db: Database,
  teamId: string,
  name: string,
  excludeId?: string
): Promise<void> {
  const slug = styleSlug(name);
  const visible = await db
    .select({ id: styles.id, name: styles.name })
    .from(styles)
    .where(
      and(
        libraryVisibleTo(teamId),
        excludeId ? ne(styles.id, excludeId) : undefined
      )
    );
  const clash = visible.find((s) => styleSlug(s.name) === slug);
  if (clash) {
    throw new ConflictError(
      `A style named “${clash.name}” already exists, which would share the URL slug “${slug}”. Choose a more distinct name.`,
      { slug, conflictsWith: clash.name }
    );
  }
}

function createStylesReadMethods(db: Database, teamId: string) {
  return {
    list: async (options: StylesListOptions = {}): Promise<Style[]> => {
      const orderBy = options.orderBy ?? 'sortOrder';
      const order =
        orderBy === 'popular'
          ? [desc(styles.usageCount), asc(styles.name)]
          : [asc(styles.sortOrder), asc(styles.name)];
      return await db
        .select()
        .from(styles)
        .where(libraryVisibleTo(teamId))
        .orderBy(...order);
    },

    /** The automatic style bound to one of this team's sequences, if any. */
    getBoundToSequence: async (sequenceId: string): Promise<Style | null> => {
      const result = await db
        .select()
        .from(styles)
        .where(
          and(eq(styles.sequenceId, sequenceId), eq(styles.teamId, teamId))
        )
        .limit(1);
      return result[0] ?? null;
    },

    /**
     * Library rows resolve by id alone (a sequence may reference a public
     * style); a sequence-bound one is private to its team.
     */
    getById: async (styleId: string): Promise<Style | null> => {
      const result = await db
        .select()
        .from(styles)
        .where(and(eq(styles.id, styleId), boundRowsOwnedBy(teamId)))
        .limit(1);
      return result[0] ?? null;
    },

    /**
     * Batched style fetch by id — resolves the style rows referenced by a page
     * of sequences in one batched fetch (one query per ≤90-id chunk), backing
     * the `style` block in the public `GET /api/v1/sequences` list. Same
     * scoping as `getById`. Duplicate ids collapse and order is not
     * guaranteed — callers index the result by id, and an id that resolves to
     * no row simply has no entry.
     */
    listByIds: async (styleIds: string[]): Promise<Style[]> => {
      if (styleIds.length === 0) return [];
      const unique = [...new Set(styleIds)];
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += STYLES_BY_IDS_BATCH) {
        batches.push(unique.slice(i, i + STYLES_BY_IDS_BATCH));
      }
      const results = await Promise.all(
        batches.map((batch) =>
          db
            .select()
            .from(styles)
            .where(and(inArray(styles.id, batch), boundRowsOwnedBy(teamId)))
        )
      );
      return results.flat();
    },
  };
}

/**
 * Public (anonymous) styles reads. Takes no team scope at all, so this code
 * path cannot express a team-scoped query — the isPublic filter is the entire
 * data boundary for the unauthenticated style-catalogue endpoint.
 */
export function createPublicStylesReadMethods(db: Database) {
  return {
    list: async (): Promise<Style[]> => {
      return await db
        .select()
        .from(styles)
        .where(and(eq(styles.isPublic, true), isNull(styles.sequenceId)))
        .orderBy(asc(styles.sortOrder), asc(styles.name));
    },
  };
}

export function createStylesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createStylesReadMethods(db, teamId),

    // Server-managed columns (isPublic, isTemplate, usageCount, …) are
    // excluded from the parameter type AND scrubbed at runtime: the type
    // alone doesn't stop a non-literal object from carrying extra keys, and
    // drizzle writes any key that matches a table column. Admin paths (the
    // system template seeder) insert via raw drizzle instead.
    create: async (
      data: Omit<NewStyle, ServerManagedStyleColumn>
    ): Promise<Style> => {
      await assertSlugAvailable(db, teamId, data.name);
      const result = await db
        .insert(styles)
        .values({
          ...stripServerManagedColumns(data, SERVER_MANAGED_STYLE_COLUMNS),
          teamId,
          createdBy: userId,
        })
        .returning();
      const style = result[0];
      if (!style) {
        throw new Error(`Failed to create Style for team ${teamId}`);
      }
      return style;
    },

    update: async (
      styleId: string,
      data: Partial<Omit<Style, ServerManagedStyleColumn>>
    ): Promise<Style | undefined> => {
      if (data.name !== undefined) {
        await assertSlugAvailable(db, teamId, data.name, styleId);
      }
      const result = await db
        .update(styles)
        .set(stripServerManagedColumns(data, SERVER_MANAGED_STYLE_COLUMNS))
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)))
        .returning();
      return Array.isArray(result) ? result[0] : undefined;
    },

    delete: async (styleId: string): Promise<void> => {
      await db
        .delete(styles)
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)));
    },

    /**
     * Automatic style (#1213): a row bound to one sequence. Created at
     * sequence creation with a placeholder recipe and filled in by the
     * storyboard run's first step. Outside the library, so no slug check.
     * Inserted before the sequence row exists (the id is pre-allocated) —
     * safe only because `sequenceId` has no FK.
     */
    createForSequence: async (params: {
      sequenceId: string;
      draft: AutoStyleDraft;
    }): Promise<Style> => {
      const result = await db
        .insert(styles)
        .values({
          ...params.draft,
          sequenceId: params.sequenceId,
          teamId,
          createdBy: userId,
        })
        .returning();
      const style = result[0];
      if (!style) {
        throw new Error(
          `Failed to create automatic style for sequence ${params.sequenceId}`
        );
      }
      return style;
    },

    /**
     * Write the script-derived recipe onto a sequence-bound style. Scoped to
     * the binding so a stale run can never rewrite a promoted (library) row.
     * Returns false when the row is no longer bound to that sequence.
     */
    setGeneratedForSequence: async (params: {
      styleId: string;
      sequenceId: string;
      draft: AutoStyleDraft;
    }): Promise<boolean> => {
      const rows = await db
        .update(styles)
        .set({ ...params.draft, updatedAt: new Date() })
        .where(
          and(
            eq(styles.id, params.styleId),
            eq(styles.sequenceId, params.sequenceId),
            eq(styles.teamId, teamId)
          )
        )
        .returning({ id: styles.id });
      return rows.length > 0;
    },

    /**
     * Promote a sequence-bound style into the team library: clears the
     * binding under the library's slug-uniqueness rule. The sequence keeps
     * pointing at the same row, so nothing downstream re-snapshots.
     */
    promoteToLibrary: async (params: {
      styleId: string;
      name: string;
      previewUrl: string | null;
    }): Promise<Style> => {
      await assertSlugAvailable(db, teamId, params.name);
      const rows = await db
        .update(styles)
        .set({
          sequenceId: null,
          name: params.name,
          previewUrl: params.previewUrl,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(styles.id, params.styleId),
            eq(styles.teamId, teamId),
            isNotNull(styles.sequenceId)
          )
        )
        .returning();
      const style = rows[0];
      if (!style) {
        throw new ValidationError(
          'Only an automatic style that is still bound to a sequence can be added to the library'
        );
      }
      return style;
    },

    incrementUsage: async (styleId: string): Promise<void> => {
      const rows = await db
        .update(styles)
        .set({ usageCount: sql`${styles.usageCount} + 1` })
        .where(eq(styles.id, styleId))
        .returning({ id: styles.id });
      if (rows.length === 0) {
        logger.warn('incrementUsage matched zero rows', { styleId });
      }
    },
  };
}
