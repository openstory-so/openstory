/**
 * Support-mode lookup (`createAdminMethods.getAllSequences` /
 * `getAllStudioAssets`): resolves a person through TEAM MEMBERSHIP, so a
 * customer's work stays reachable by their email even when a creator column
 * is missing — the state the #612-class table-rebuild left 174 prod sequences
 * in. Studio `userId` is required, but lookup still goes through membership
 * so a teammate's stills/clips show up under the customer's email (#1568).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import {
  generatedAssets,
  sequences,
  styles,
  teamMembers,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { Database } from '@/platform/server/db/client';
import { createAdminMethods } from './admin';

let client: Client;
let db: Database;

const styleConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

// One team (owner "Tanner") whose sequences all have a NULL creator, plus an
// unrelated team, so we can assert both "found by member email" and "other
// teams excluded".
const ids = {
  tannerUser: '',
  tannerTeammate: '',
  tannerTeam: '',
  tannerStyle: '',
  liveSeq: '',
  archivedSeq: '',
  otherUser: '',
  otherTeam: '',
  otherStyle: '',
  otherSeq: '',
  tannerImage: '',
  tannerTeammateImage: '',
  tannerVideo: '',
  tannerCatalog: '',
  otherImage: '',
};

async function seed() {
  await db.delete(generatedAssets);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teamMembers);
  await db.delete(teams);
  await db.delete(user);

  ids.tannerUser = generateId();
  ids.tannerTeammate = generateId();
  ids.tannerTeam = generateId();
  ids.otherUser = generateId();
  ids.otherTeam = generateId();
  ids.liveSeq = generateId();
  ids.archivedSeq = generateId();
  ids.otherSeq = generateId();
  ids.tannerImage = generateId();
  ids.tannerTeammateImage = generateId();
  ids.tannerVideo = generateId();
  ids.tannerCatalog = generateId();
  ids.otherImage = generateId();

  await db.insert(user).values([
    { id: ids.tannerUser, name: 'Tanner Linsley', email: 'tanner@example.com' },
    {
      id: ids.tannerTeammate,
      name: 'Teammate',
      email: 'teammate@example.com',
    },
    { id: ids.otherUser, name: 'Someone Else', email: 'other@example.com' },
  ]);
  await db.insert(teams).values([
    { id: ids.tannerTeam, name: 'Tanner', slug: 'tanner' },
    { id: ids.otherTeam, name: 'Other', slug: 'other' },
  ]);
  await db.insert(teamMembers).values([
    { teamId: ids.tannerTeam, userId: ids.tannerUser, role: 'owner' },
    { teamId: ids.tannerTeam, userId: ids.tannerTeammate, role: 'member' },
    { teamId: ids.otherTeam, userId: ids.otherUser, role: 'owner' },
  ]);
  const [tannerStyle, otherStyle] = await db
    .insert(styles)
    .values([
      { teamId: ids.tannerTeam, name: 'tanner-style', config: styleConfig },
      { teamId: ids.otherTeam, name: 'other-style', config: styleConfig },
    ])
    .returning();
  if (!tannerStyle || !otherStyle) {
    throw new Error('test setup: style insert returned nothing');
  }
  ids.tannerStyle = tannerStyle.id;
  ids.otherStyle = otherStyle.id;

  // createdBy intentionally omitted (NULL) — the exact state the migration left.
  await db.insert(sequences).values([
    {
      id: ids.liveSeq,
      teamId: ids.tannerTeam,
      title: 'Hidden Divide',
      styleId: ids.tannerStyle,
      status: 'completed',
    },
    {
      id: ids.archivedSeq,
      teamId: ids.tannerTeam,
      title: 'Old Teaser',
      styleId: ids.tannerStyle,
      status: 'archived',
    },
    {
      id: ids.otherSeq,
      teamId: ids.otherTeam,
      title: 'Unrelated',
      styleId: ids.otherStyle,
      status: 'completed',
    },
  ]);

  await db.insert(generatedAssets).values([
    {
      id: ids.tannerImage,
      teamId: ids.tannerTeam,
      userId: ids.tannerUser,
      provider: 'fal',
      endpointId: 'fal-ai/flux-1/dev',
      activity: 'image',
      modelName: 'FLUX.1 [dev]',
      source: 'studio',
      input: { prompt: 'a red fox' },
      status: 'completed',
    },
    {
      id: ids.tannerTeammateImage,
      teamId: ids.tannerTeam,
      userId: ids.tannerTeammate,
      provider: 'fal',
      endpointId: 'fal-ai/flux-1/dev',
      activity: 'image',
      modelName: 'FLUX.1 [dev]',
      source: 'studio',
      input: { prompt: 'a blue heron' },
      status: 'completed',
    },
    {
      id: ids.tannerVideo,
      teamId: ids.tannerTeam,
      userId: ids.tannerUser,
      provider: 'fal',
      endpointId: 'fal-ai/kling-video',
      activity: 'video',
      modelName: 'Kling',
      source: 'studio',
      input: { prompt: 'fox runs' },
      status: 'completed',
    },
    {
      id: ids.tannerCatalog,
      teamId: ids.tannerTeam,
      userId: ids.tannerUser,
      provider: 'fal',
      endpointId: 'fal-ai/flux-1/dev',
      activity: 'image',
      modelName: 'FLUX.1 [dev]',
      source: 'catalog',
      input: { prompt: 'catalog only' },
      status: 'completed',
    },
    {
      id: ids.otherImage,
      teamId: ids.otherTeam,
      userId: ids.otherUser,
      provider: 'fal',
      endpointId: 'fal-ai/flux-1/dev',
      activity: 'image',
      modelName: 'FLUX.1 [dev]',
      source: 'studio',
      input: { prompt: 'unrelated still' },
      status: 'completed',
    },
  ]);
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

describe('createAdminMethods.getAllSequences', () => {
  it('finds a team’s sequences by a member email even when created_by is NULL', async () => {
    const admin = createAdminMethods(db);
    const rows = await admin.getAllSequences({ search: 'tanner@example.com' });

    // The live sequence surfaces via team membership; the archived one and the
    // other team never do.
    expect(rows.map((r) => r.id)).toEqual([ids.liveSeq]);
  });

  it('excludes archived sequences and other teams', async () => {
    const admin = createAdminMethods(db);
    const rows = await admin.getAllSequences({ search: 'tanner' });

    const returnedIds = rows.map((r) => r.id);
    expect(returnedIds).toContain(ids.liveSeq);
    expect(returnedIds).not.toContain(ids.archivedSeq);
    expect(returnedIds).not.toContain(ids.otherSeq);
  });

  it('still matches on sequence title', async () => {
    const admin = createAdminMethods(db);
    const rows = await admin.getAllSequences({ search: 'hidden divide' });
    expect(rows.map((r) => r.id)).toEqual([ids.liveSeq]);
  });
});

describe('createAdminMethods.getAllStudioAssets', () => {
  it('lists every studio asset across teams when unfiltered', async () => {
    const admin = createAdminMethods(db);
    const { assets, nextCursor } = await admin.getAllStudioAssets();

    expect(assets.map((a) => a.id).sort()).toEqual(
      [
        ids.tannerImage,
        ids.tannerTeammateImage,
        ids.tannerVideo,
        ids.otherImage,
      ].sort()
    );
    expect(nextCursor).toBeNull();
    expect(assets.some((a) => a.id === ids.tannerCatalog)).toBe(false);
  });

  it("finds a team's studio stills by a member email, including a teammate's", async () => {
    const admin = createAdminMethods(db);
    const { assets } = await admin.getAllStudioAssets({
      activity: 'image',
      search: 'tanner@example.com',
    });

    expect(assets.map((a) => a.id).sort()).toEqual(
      [ids.tannerImage, ids.tannerTeammateImage].sort()
    );
    expect(assets.find((a) => a.id === ids.tannerImage)?.creatorEmail).toBe(
      'tanner@example.com'
    );
    expect(
      assets.find((a) => a.id === ids.tannerTeammateImage)?.creatorEmail
    ).toBe('teammate@example.com');
  });

  it('excludes catalog runs, other teams, and the other activity', async () => {
    const admin = createAdminMethods(db);
    const { assets } = await admin.getAllStudioAssets({
      activity: 'video',
      search: 'tanner',
    });

    expect(assets.map((a) => a.id)).toEqual([ids.tannerVideo]);
  });

  it('matches a snapshotted prompt', async () => {
    const admin = createAdminMethods(db);
    const { assets } = await admin.getAllStudioAssets({
      search: 'blue heron',
    });
    expect(assets.map((a) => a.id)).toEqual([ids.tannerTeammateImage]);
  });

  it('paginates newest-first with a keyset cursor', async () => {
    const admin = createAdminMethods(db);
    // Insert order of studio rows (catalog is skipped by the query).
    const newestFirst = [
      ids.otherImage,
      ids.tannerVideo,
      ids.tannerTeammateImage,
      ids.tannerImage,
    ];

    const page1 = await admin.getAllStudioAssets({ limit: 2 });
    expect(page1.assets.map((a) => a.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.nextCursor).toBe(newestFirst[1]);

    const page2 = await admin.getAllStudioAssets({
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.assets.map((a) => a.id)).toEqual(newestFirst.slice(2));
    expect(page2.nextCursor).toBeNull();
  });
});
