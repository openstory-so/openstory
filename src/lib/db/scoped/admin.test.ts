/**
 * Support-mode lookup (`createAdminMethods.getAllSequences`): resolves a person
 * through TEAM MEMBERSHIP, so a customer's sequences stay reachable by their
 * email even when `sequences.created_by` is NULL — the state the #612-class
 * table-rebuild left 174 prod rows in. Guards against regressing back to a
 * creator-only filter that strands those rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/shared/id';
import { sequences, styles, teamMembers, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
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
  tannerTeam: '',
  tannerStyle: '',
  liveSeq: '',
  archivedSeq: '',
  otherUser: '',
  otherTeam: '',
  otherStyle: '',
  otherSeq: '',
};

async function seed() {
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teamMembers);
  await db.delete(teams);
  await db.delete(user);

  ids.tannerUser = generateId();
  ids.tannerTeam = generateId();
  ids.otherUser = generateId();
  ids.otherTeam = generateId();
  ids.liveSeq = generateId();
  ids.archivedSeq = generateId();
  ids.otherSeq = generateId();

  await db.insert(user).values([
    { id: ids.tannerUser, name: 'Tanner Linsley', email: 'tanner@example.com' },
    { id: ids.otherUser, name: 'Someone Else', email: 'other@example.com' },
  ]);
  await db.insert(teams).values([
    { id: ids.tannerTeam, name: 'Tanner', slug: 'tanner' },
    { id: ids.otherTeam, name: 'Other', slug: 'other' },
  ]);
  await db.insert(teamMembers).values([
    { teamId: ids.tannerTeam, userId: ids.tannerUser, role: 'owner' },
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
