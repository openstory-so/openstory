/**
 * Support-mode lookup (`createAdminMethods.getAllSequences` /
 * `getAllStudioAssets`): resolves a person through ORGANIZATION MEMBERSHIP, so a
 * customer's work stays reachable by their email even when a creator column
 * is missing — the state the #612-class table-rebuild left 174 prod sequences
 * in. Studio `userId` is required, but lookup still goes through membership
 * so a teammate's stills/clips show up under the customer's email (#1568).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import {
  generatedAssets,
  sequences,
  styles,
  member,
  organization,
  user,
} from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';
import { createAdminMethods } from './admin';

let closeDb: () => Promise<void>;
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

// One organization (owner "Tanner") whose sequences all have a NULL creator, plus an
// unrelated organization, so we can assert both "found by member email" and "other
// organization excluded".
const ids = {
  tannerUser: '',
  tannerTeammate: '',
  tannerOrganization: '',
  tannerStyle: '',
  liveSeq: '',
  archivedSeq: '',
  otherUser: '',
  otherOrganization: '',
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
  await db.delete(member);
  await db.delete(organization);
  await db.delete(user);

  ids.tannerUser = generateId();
  ids.tannerTeammate = generateId();
  ids.tannerOrganization = generateId();
  ids.otherUser = generateId();
  ids.otherOrganization = generateId();
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
  await db.insert(organization).values([
    { id: ids.tannerOrganization, name: 'Tanner', slug: 'tanner' },
    { id: ids.otherOrganization, name: 'Other', slug: 'other' },
  ]);
  const joined = new Date();
  await db.insert(member).values([
    {
      id: ids.tannerUser,
      organizationId: ids.tannerOrganization,
      userId: ids.tannerUser,
      role: 'owner',
      createdAt: joined,
    },
    {
      id: ids.tannerTeammate,
      organizationId: ids.tannerOrganization,
      userId: ids.tannerTeammate,
      role: 'member',
      createdAt: joined,
    },
    {
      id: ids.otherUser,
      organizationId: ids.otherOrganization,
      userId: ids.otherUser,
      role: 'owner',
      createdAt: joined,
    },
  ]);
  const [tannerStyle, otherStyle] = await db
    .insert(styles)
    .values([
      {
        organizationId: ids.tannerOrganization,
        name: 'tanner-style',
        config: styleConfig,
      },
      {
        organizationId: ids.otherOrganization,
        name: 'other-style',
        config: styleConfig,
      },
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
      organizationId: ids.tannerOrganization,
      title: 'Hidden Divide',
      styleId: ids.tannerStyle,
      status: 'completed',
    },
    {
      id: ids.archivedSeq,
      organizationId: ids.tannerOrganization,
      title: 'Old Teaser',
      styleId: ids.tannerStyle,
      status: 'archived',
    },
    {
      id: ids.otherSeq,
      organizationId: ids.otherOrganization,
      title: 'Unrelated',
      styleId: ids.otherStyle,
      status: 'completed',
    },
  ]);

  await db.insert(generatedAssets).values([
    {
      id: ids.tannerImage,
      organizationId: ids.tannerOrganization,
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
      organizationId: ids.tannerOrganization,
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
      organizationId: ids.tannerOrganization,
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
      organizationId: ids.tannerOrganization,
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
      organizationId: ids.otherOrganization,
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
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await seed();
});

describe('createAdminMethods.getAllSequences', () => {
  it('finds an organization’s sequences by a member email even when created_by is NULL', async () => {
    const admin = createAdminMethods(db);
    const rows = await admin.getAllSequences({ search: 'tanner@example.com' });

    // The live sequence surfaces via organization membership; the archived one and the
    // other organization never do.
    expect(rows.map((r) => r.id)).toEqual([ids.liveSeq]);
  });

  it('excludes archived sequences and other organizations', async () => {
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
  it('lists every studio asset across organizations when unfiltered', async () => {
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

  it("finds an organization's studio stills by a member email, including a teammate's", async () => {
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

  it('excludes catalog runs, other organizations, and the other activity', async () => {
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
