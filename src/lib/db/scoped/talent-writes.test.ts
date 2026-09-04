/**
 * Write-side ACL tests for scoped talent mutations. Public/system templates
 * are readable cross-team but must not accept sheet/media/talent writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/shared/id';
import {
  talent,
  talentMedia,
  talentSheetVariants,
  talentSheets,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createTalentMethods, isTeamWritableTalent } from './talent';
import { createTalentSheetVariantsMethods } from './talent-sheet-variants';

let client: Client;
let db: Database;

const teamA = { id: '', name: 'Team A', slug: 'team-a' };
const teamB = { id: '', name: 'Team B', slug: 'team-b' };
const userA = { id: '', name: 'User A', email: 'a@example.com' };

let publicTalentId = '';
let publicSheetId = '';
let publicMediaId = '';

async function seedFixtures() {
  await db.delete(talentSheetVariants);
  await db.delete(talentMedia);
  await db.delete(talentSheets);
  await db.delete(talent);
  await db.delete(teams);
  await db.delete(user);

  teamA.id = generateId();
  teamB.id = generateId();
  userA.id = generateId();

  await db
    .insert(user)
    .values([{ id: userA.id, name: userA.name, email: userA.email }]);
  await db.insert(teams).values([teamA, teamB]);

  const [publicTalent] = await db
    .insert(talent)
    .values({ teamId: teamB.id, name: 'System Template', isPublic: true })
    .returning();
  if (!publicTalent) throw new Error('Failed to seed public talent');
  publicTalentId = publicTalent.id;

  const [sheet] = await db
    .insert(talentSheets)
    .values({
      talentId: publicTalentId,
      name: 'Default',
      imageUrl: 'https://example.com/sheet.png',
    })
    .returning();
  if (!sheet) throw new Error('Failed to seed public sheet');
  publicSheetId = sheet.id;

  const [media] = await db
    .insert(talentMedia)
    .values({
      talentId: publicTalentId,
      type: 'image',
      url: 'https://example.com/ref.png',
      path: 'talent/ref.png',
    })
    .returning();
  if (!media) throw new Error('Failed to seed public media');
  publicMediaId = media.id;
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
  await seedFixtures();
});

describe('isTeamWritableTalent', () => {
  it('rejects public talent even when teamId matches', () => {
    expect(
      isTeamWritableTalent({ teamId: teamB.id, isPublic: true }, teamB.id)
    ).toBe(false);
  });
});

describe('scoped talent write ACL', () => {
  const teamAMethods = () => createTalentMethods(db, teamA.id, userA.id);

  it('blocks update on public talent owned by another team', async () => {
    const result = await teamAMethods().update(publicTalentId, {
      name: 'Hacked',
    });
    expect(result).toBeUndefined();
  });

  it('blocks delete on public talent owned by another team', async () => {
    expect(await teamAMethods().delete(publicTalentId)).toBe(false);
  });

  it('blocks sheet create on public talent visible to another team', async () => {
    await expect(
      teamAMethods().sheets.create({
        talentId: publicTalentId,
        name: 'Injected',
        imageUrl: 'https://example.com/injected.png',
      })
    ).rejects.toThrow(/permission to modify/);
  });

  it('blocks sheet delete on public talent sheets', async () => {
    expect(await teamAMethods().sheets.delete(publicSheetId)).toBe(false);
  });

  it('blocks media create on public talent', async () => {
    await expect(
      teamAMethods().media.create({
        talentId: publicTalentId,
        type: 'image',
        url: 'https://example.com/new.png',
        path: 'talent/new.png',
      })
    ).rejects.toThrow(/permission to modify/);
  });

  it('blocks media delete on public talent media', async () => {
    expect(await teamAMethods().media.delete(publicMediaId)).toBe(false);
  });

  it('blocks update on public talent owned by the same team', async () => {
    const ownerMethods = createTalentMethods(db, teamB.id, userA.id);
    const result = await ownerMethods.update(publicTalentId, {
      name: 'Renamed Template',
    });
    expect(result).toBeUndefined();
  });
});

describe('scoped talent sheet variant write ACL', () => {
  const teamAVariants = () => createTalentSheetVariantsMethods(db, teamA.id);

  it('blocks insertDivergent on a public talent sheet', async () => {
    await expect(
      teamAVariants().insertDivergent({
        talentSheetId: publicSheetId,
        model: 'flux-pro',
        url: 'https://example.com/divergent.png',
        status: 'completed',
        inputHash: 'hash-1',
        divergedAt: new Date(),
      })
    ).rejects.toThrow(/permission to modify/);
  });

  it('blocks promoteAtomically on a public talent sheet', async () => {
    const variants = teamAVariants();
    const variant = await db
      .insert(talentSheetVariants)
      .values({
        talentSheetId: publicSheetId,
        model: 'flux-pro',
        url: 'https://example.com/divergent.png',
        status: 'completed',
        inputHash: 'hash-promote',
        divergedAt: new Date(),
      })
      .returning();
    const row = variant[0];
    if (!row) throw new Error('Failed to seed variant');

    await expect(
      variants.promoteAtomically(
        publicSheetId,
        {
          imageUrl: row.url,
          imagePath: row.storagePath,
          inputHash: row.inputHash,
        },
        row.id
      )
    ).rejects.toThrow(/permission to modify/);
  });
});
