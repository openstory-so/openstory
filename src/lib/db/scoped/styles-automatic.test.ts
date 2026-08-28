/**
 * Automatic (sequence-bound) styles (#1213): outside the library until
 * promoted, written only while still bound, cleaned up with the sequence.
 */
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { sequences, styles, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createSequencesMethods } from '@/lib/db/scoped/sequences';
import {
  createPublicStylesReadMethods,
  createStylesMethods,
} from '@/lib/db/scoped/styles';
import { placeholderAutoStyleDraft } from '@/lib/style/auto-style';
import { parseStyleConfig } from '@/lib/style/style-config';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);
  teamId = generateId();
  userId = generateId();
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: 'u@example.com' });
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
});

const derived = () => ({
  ...placeholderAutoStyleDraft(),
  name: 'Rain-slick Neon Noir',
  description: 'Wet streets and neon.',
  category: 'film',
  tags: ['noir'],
});

async function seedLibraryStyle(name: string, isPublic = false) {
  const [row] = await db
    .insert(styles)
    .values({
      teamId,
      name,
      config: placeholderAutoStyleDraft().config,
      isPublic,
    })
    .returning();
  if (!row) throw new Error('style insert returned nothing');
  return row;
}

async function createAutoSequence() {
  const stylesDb = createStylesMethods(db, teamId, userId);
  const sequencesDb = createSequencesMethods(db, teamId, userId);
  const sequenceId = generateId();
  const style = await stylesDb.createForSequence({
    sequenceId,
    draft: placeholderAutoStyleDraft(),
  });
  const sequence = await sequencesDb.create({
    id: sequenceId,
    title: 'S',
    styleId: style.id,
    deferStyleSnapshot: true,
    analysisModel: 'anthropic/claude-haiku-4.5',
  });
  return { stylesDb, sequencesDb, style, sequence };
}

describe('automatic styles', () => {
  it('are excluded from the team and public library lists', async () => {
    await seedLibraryStyle('Noir');
    const { stylesDb, style } = await createAutoSequence();

    const listed = await stylesDb.list();
    expect(listed.map((s) => s.name)).toEqual(['Noir']);
    expect(listed.some((s) => s.id === style.id)).toBe(false);
    expect(await createPublicStylesReadMethods(db).list()).toEqual([]);
  });

  it('create honours the pre-allocated id and defers the style snapshot', async () => {
    const { sequence, style } = await createAutoSequence();
    expect(style.sequenceId).toBe(sequence.id);
    expect(sequence.styleId).toBe(style.id);
    expect(sequence.styleConfig).toBeNull();
  });

  it('setGeneratedForSequence writes the recipe and snapshotAutoStyle copies it', async () => {
    const { stylesDb, sequencesDb, sequence, style } =
      await createAutoSequence();

    const bound = await stylesDb.setGeneratedForSequence({
      styleId: style.id,
      sequenceId: sequence.id,
      draft: derived(),
    });
    expect(bound).toBe(true);

    expect(
      await sequencesDb.snapshotAutoStyle({
        id: sequence.id,
        styleId: style.id,
      })
    ).toBe(true);
    const updated = await sequencesDb.getById(sequence.id);
    expect(parseStyleConfig(updated?.styleConfig).look.mood).toBe(
      derived().config.look.mood
    );
    const row = await stylesDb.getBoundToSequence(sequence.id);
    expect(row?.name).toBe('Rain-slick Neon Noir');
  });

  it('snapshotAutoStyle leaves a library style picked mid-run untouched', async () => {
    const library = await seedLibraryStyle('Noir');
    const { stylesDb, sequencesDb, sequence, style } =
      await createAutoSequence();
    await sequencesDb.update({ id: sequence.id, styleId: library.id });
    await stylesDb.setGeneratedForSequence({
      styleId: style.id,
      sequenceId: sequence.id,
      draft: derived(),
    });

    expect(
      await sequencesDb.snapshotAutoStyle({
        id: sequence.id,
        styleId: style.id,
      })
    ).toBe(false);
    const after = await sequencesDb.getById(sequence.id);
    expect(after?.styleId).toBe(library.id);
    expect(parseStyleConfig(after?.styleConfig).look.mood).toBe(
      placeholderAutoStyleDraft().config.look.mood
    );
  });

  it('getById/listByIds hide another team’s bound row but resolve library rows', async () => {
    const { style } = await createAutoSequence();
    const library = await seedLibraryStyle('Noir');
    const otherTeam = createStylesMethods(db, generateId(), userId);

    expect(await otherTeam.getById(style.id)).toBeNull();
    expect(await otherTeam.getById(library.id)).toMatchObject({
      id: library.id,
    });
    expect(
      (await otherTeam.listByIds([style.id, library.id])).map((s) => s.id)
    ).toEqual([library.id]);
    const own = createStylesMethods(db, teamId, userId);
    expect(await own.getById(style.id)).toMatchObject({ id: style.id });
  });

  it('setGeneratedForSequence refuses once the row is no longer bound', async () => {
    const { stylesDb, sequence, style } = await createAutoSequence();
    await db
      .update(styles)
      .set({ sequenceId: null })
      .where(eq(styles.id, style.id));

    expect(
      await stylesDb.setGeneratedForSequence({
        styleId: style.id,
        sequenceId: sequence.id,
        draft: derived(),
      })
    ).toBe(false);
  });

  it('promoteToLibrary clears the binding and makes the row listable', async () => {
    const { stylesDb, sequence, style } = await createAutoSequence();
    await stylesDb.setGeneratedForSequence({
      styleId: style.id,
      sequenceId: sequence.id,
      draft: derived(),
    });

    const promoted = await stylesDb.promoteToLibrary({
      styleId: style.id,
      name: 'My Neon Noir',
      previewUrl: '/r2/poster.webp',
    });
    expect(promoted.sequenceId).toBeNull();
    expect(promoted.name).toBe('My Neon Noir');
    expect(promoted.previewUrl).toBe('/r2/poster.webp');
    expect((await stylesDb.list()).map((s) => s.id)).toEqual([style.id]);
    expect(await stylesDb.getBoundToSequence(sequence.id)).toBeNull();
  });

  it('promoteToLibrary enforces the library slug rule but ignores other bound rows', async () => {
    await seedLibraryStyle('Neon Noir', true);
    const first = await createAutoSequence();
    const second = await createAutoSequence();

    await expect(
      first.stylesDb.promoteToLibrary({
        styleId: first.style.id,
        name: 'neon-noir',
        previewUrl: null,
      })
    ).rejects.toThrow(/already exists/);

    // Two bound rows may share a name; only the library is checked.
    await second.stylesDb.setGeneratedForSequence({
      styleId: second.style.id,
      sequenceId: second.sequence.id,
      draft: { ...derived(), name: 'Shared Name' },
    });
    await expect(
      first.stylesDb.promoteToLibrary({
        styleId: first.style.id,
        name: 'Shared Name',
        previewUrl: null,
      })
    ).resolves.toMatchObject({ sequenceId: null });
  });

  it('promoteToLibrary rejects a row that is already in the library', async () => {
    const library = await seedLibraryStyle('Noir');
    const stylesDb = createStylesMethods(db, teamId, userId);
    await expect(
      stylesDb.promoteToLibrary({
        styleId: library.id,
        name: 'Renamed',
        previewUrl: null,
      })
    ).rejects.toThrow(/still bound/);
  });

  it('deleting the sequence removes its bound style', async () => {
    const { sequencesDb, sequence, style } = await createAutoSequence();
    await sequencesDb.delete(sequence.id);
    const rows = await db.select().from(styles).where(eq(styles.id, style.id));
    expect(rows).toEqual([]);
  });
});
