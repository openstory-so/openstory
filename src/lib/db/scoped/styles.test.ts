/**
 * Scoped styles tests:
 *   - incrementUsage atomically bumps usageCount.
 *   - list({ orderBy: 'popular' }) sorts by usageCount desc.
 *   - createPublicStylesReadMethods().list() never leaks private team styles
 *     (guards the unauthenticated public-catalogue endpoint).
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  styles,
  teams,
  user,
  type NewStyle,
  type Style,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import {
  createPublicStylesReadMethods,
  createStylesMethods,
} from '@/lib/db/scoped/styles';
import { ConflictError } from '@/lib/errors';
import type { ServerManagedStyleColumn } from '@/lib/schemas/style.schemas';
import { createClient, type Client } from '@libsql/client';
import { asc, desc, eq, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// scoped.test.ts registers a global module mock for @/lib/db/scoped/styles
// via vi.doMock(). vi.doMock is per-file, so it shouldn't bleed across the
// suite, but we mirror the production methods inline against an in-memory
// libSQL DB anyway to exercise real SQL behavior without depending on the
// other file's mock setup. Keep these in lockstep with the *team-scoped*
// methods in @/lib/db/scoped/styles only — the public read path is exercised
// via the real createPublicStylesReadMethods factory below, not mirrored.
function makeStylesMethods(database: Database, teamId: string, userId: string) {
  return {
    list: async (
      options: { orderBy?: 'popular' | 'sortOrder' } = {}
    ): Promise<Style[]> => {
      const orderBy = options.orderBy ?? 'sortOrder';
      const order =
        orderBy === 'popular'
          ? [desc(styles.usageCount), asc(styles.name)]
          : [asc(styles.sortOrder), asc(styles.name)];
      return await database
        .select()
        .from(styles)
        .where(or(eq(styles.teamId, teamId), eq(styles.isPublic, true)))
        .orderBy(...order);
    },
    getById: async (styleId: string): Promise<Style | null> => {
      const result = await database
        .select()
        .from(styles)
        .where(eq(styles.id, styleId))
        .limit(1);
      return result[0] ?? null;
    },
    create: async (
      data: Omit<NewStyle, ServerManagedStyleColumn>
    ): Promise<Style> => {
      const result = await database
        .insert(styles)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      const style = result[0];
      if (!style) throw new Error('insert returned nothing');
      return style;
    },
    incrementUsage: async (styleId: string): Promise<void> => {
      const rows = await database
        .update(styles)
        .set({ usageCount: sql`${styles.usageCount} + 1` })
        .where(eq(styles.id, styleId))
        .returning({ id: styles.id });
      if (rows.length === 0) {
        console.warn('[styles] incrementUsage matched zero rows', { styleId });
      }
    },
  };
}

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };

const baseConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

// isPublic is server-managed (excluded from the scoped create/update types),
// so tests publish a style the way admin paths do: a raw drizzle write.
async function markPublic(styleId: string) {
  await db.update(styles).set({ isPublic: true }).where(eq(styles.id, styleId));
}

async function seed() {
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('createStylesMethods.incrementUsage', () => {
  it('bumps usageCount by 1 on each call', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const style = await methods.create({
      name: 'Bumped',
      config: baseConfig,
    });
    expect(style.usageCount).toBe(0);

    await methods.incrementUsage(style.id);
    await methods.incrementUsage(style.id);

    const after = await methods.getById(style.id);
    expect(after?.usageCount).toBe(2);
  });

  it('logs a warning when the styleId matches zero rows', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await methods.incrementUsage('does_not_exist');
      expect(warn).toHaveBeenCalledWith(
        '[styles] incrementUsage matched zero rows',
        { styleId: 'does_not_exist' }
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createStylesMethods.list({ orderBy: 'popular' })", () => {
  it('orders by usageCount desc when popular requested', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    // All three share the default sortOrder, so the sortOrder listing falls
    // back to name asc (A, B, C).
    const a = await methods.create({
      name: 'A-cold',
      config: baseConfig,
    });
    const b = await methods.create({
      name: 'B-hot',
      config: baseConfig,
    });
    const c = await methods.create({
      name: 'C-warm',
      config: baseConfig,
    });

    await methods.incrementUsage(b.id);
    await methods.incrementUsage(b.id);
    await methods.incrementUsage(b.id);
    await methods.incrementUsage(c.id);

    const popular = await methods.list({ orderBy: 'popular' });
    expect(popular.map((s) => s.id)).toEqual([b.id, c.id, a.id]);

    const sorted = await methods.list();
    expect(sorted.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it('includes public styles owned by other teams', async () => {
    const otherTeamId = generateId();
    await db
      .insert(teams)
      .values([{ id: otherTeamId, name: 'Other', slug: 'o' }]);

    const ownMethods = makeStylesMethods(db, team.id, userRow.id);
    const otherMethods = makeStylesMethods(db, otherTeamId, userRow.id);

    const mine = await ownMethods.create({
      name: 'Mine',
      config: baseConfig,
    });
    const theirsPublic = await otherMethods.create({
      name: 'TheirsPublic',
      config: baseConfig,
    });
    await markPublic(theirsPublic.id);
    const theirsPrivate = await otherMethods.create({
      name: 'TheirsPrivate',
      config: baseConfig,
    });

    const visible = await ownMethods.list();
    const ids = visible.map((s) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(theirsPublic.id);
    expect(ids).not.toContain(theirsPrivate.id);
  });
});

describe('createStylesMethods.listByIds', () => {
  it('resolves a set of ids in one call, skipping unknown ids and de-duping', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    const a = await methods.create({ name: 'A', config: baseConfig });
    const b = await methods.create({ name: 'B', config: baseConfig });

    const rows = await methods.listByIds([a.id, b.id, a.id, 'missing']);
    const ids = rows.map((s) => s.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('returns an empty array for no ids without hitting the DB', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    expect(await methods.listByIds([])).toEqual([]);
  });

  it('resolves more ids than the 90-per-query batch in one call', async () => {
    // The whole point of the method is to stay under D1's 100-bound-parameter
    // ceiling by chunking. Insert 95 styles directly (bypassing the slug guard,
    // which is irrelevant here) so the request spans two batches, and assert
    // every id comes back across the Promise.all(...).flat() reassembly.
    const ids = Array.from({ length: 95 }, () => generateId());
    const rows: NewStyle[] = ids.map((id, i) => ({
      id,
      teamId: team.id,
      name: `Batch Style ${i}`,
      config: baseConfig,
    }));
    await db.insert(styles).values(rows);

    const fetched = await createStylesMethods(
      db,
      team.id,
      userRow.id
    ).listByIds(ids);
    expect(new Set(fetched.map((s) => s.id))).toEqual(new Set(ids));
  });
});

describe('createPublicStylesReadMethods', () => {
  // Uses the REAL production read methods (not the inline mirror above):
  // this factory backs getPublicStylesFn, an endpoint with no auth
  // middleware, so its isPublic filter is the entire data-leak barrier.
  it('returns only public styles, never private team styles', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const pub = await methods.create({
      name: 'Public',
      config: baseConfig,
    });
    await markPublic(pub.id);
    const priv = await methods.create({
      name: 'Private',
      config: baseConfig,
    });

    const visible = await createPublicStylesReadMethods(db).list();
    const ids = visible.map((s) => s.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);
  });
});

// Uses the REAL createStylesMethods: the Omit<> parameter types exclude
// server-managed columns, but TypeScript's excess-property check applies only
// to fresh object literals — a non-literal object with extra keys passes the
// type checker, and drizzle would write any key matching a table column. The
// runtime scrub in the write methods is the barrier these tests pin.
describe('createStylesMethods server-managed column scrubbing (runtime)', () => {
  it('drops a smuggled isPublic on create', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);

    const smuggled: {
      name: string;
      config: typeof baseConfig;
      isPublic: boolean;
    } = { name: 'Smuggled', config: baseConfig, isPublic: true };
    const created = await methods.create(smuggled);

    expect(created.isPublic).toBe(false);
    const publicIds = (await createPublicStylesReadMethods(db).list()).map(
      (s) => s.id
    );
    expect(publicIds).not.toContain(created.id);
  });

  it('drops a smuggled isPublic on update while applying the rest', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    const style = await methods.create({ name: 'Target', config: baseConfig });

    const smuggled: { name: string; isPublic: boolean } = {
      name: 'Renamed Target',
      isPublic: true,
    };
    const updated = await methods.update(style.id, smuggled);

    expect(updated?.name).toBe('Renamed Target');
    expect(updated?.isPublic).toBe(false);
  });
});

describe('createStylesMethods.create — new schema fields round-trip', () => {
  it('persists sampleVideos, useCases, recommended* and defaultAspectRatio', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const created = await methods.create({
      name: 'Loaded',
      config: baseConfig,
      sampleVideos: [
        {
          url: 'https://example.com/v.mp4',
          kind: 'canonical',
          label: 'demo',
          durationSeconds: 5,
          order: 0,
        },
      ],
      useCases: ['promo', 'social'],
      recommendedImageModel: 'flux_pro',
      recommendedVideoModel: 'wan_i2v',
      defaultAspectRatio: '16:9',
    });

    const fetched = await methods.getById(created.id);
    expect(fetched?.sampleVideos).toEqual([
      {
        url: 'https://example.com/v.mp4',
        kind: 'canonical',
        label: 'demo',
        durationSeconds: 5,
        order: 0,
      },
    ]);
    expect(fetched?.useCases).toEqual(['promo', 'social']);
    expect(fetched?.recommendedImageModel).toBe('flux_pro');
    expect(fetched?.recommendedVideoModel).toBe('wan_i2v');
    expect(fetched?.defaultAspectRatio).toBe('16:9');
  });
});

// Uses the REAL createStylesMethods (not the inline mirror) so the slug guard
// is exercised. The slug is derived from the name, so collisions are
// case/punctuation/whitespace-insensitive.
describe('createStylesMethods slug uniqueness (#956)', () => {
  it('rejects a new style whose slug collides with a public style', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    const noir = await methods.create({
      name: 'Cinematic Noir',
      config: baseConfig,
    });
    await markPublic(noir.id);
    await expect(
      methods.create({ name: 'cinematic  noir!', config: baseConfig })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects a new style whose slug collides with another style in the same team', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    await methods.create({ name: 'My Style', config: baseConfig });
    await expect(
      methods.create({ name: 'MY  style', config: baseConfig })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows a distinct slug', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    await methods.create({ name: 'Alpha', config: baseConfig });
    await expect(
      methods.create({ name: 'Beta', config: baseConfig })
    ).resolves.toBeDefined();
  });

  it("does not collide with another team's PRIVATE style (slug is unique within team ∪ public only)", async () => {
    const teamB = { id: generateId(), name: 'T2', slug: 't2' };
    await db.insert(teams).values([teamB]);

    await createStylesMethods(db, team.id, userRow.id).create({
      name: 'Shared',
      config: baseConfig, // private to team A
    });
    await expect(
      createStylesMethods(db, teamB.id, userRow.id).create({
        name: 'Shared',
        config: baseConfig,
      })
    ).resolves.toBeDefined();
  });

  it('rename rejects a colliding name but allows renaming a style against its own slug', async () => {
    const methods = createStylesMethods(db, team.id, userRow.id);
    const first = await methods.create({ name: 'First', config: baseConfig });
    const second = await methods.create({ name: 'Second', config: baseConfig });

    await expect(
      methods.update(second.id, { name: 'first' })
    ).rejects.toBeInstanceOf(ConflictError);

    // excludeId skips the row being renamed, so a same-slug variant of its own
    // name is allowed.
    await expect(
      methods.update(first.id, { name: 'First!' })
    ).resolves.toBeDefined();
  });
});
