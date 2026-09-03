/**
 * `sequences.create` must PERSIST the settings the composer chose.
 *
 * `generateStartFrames` shipped validated, capability-checked against the team's
 * vias, and priced into the credit estimate — and then not written. The column
 * default is 0, so every sequence came back with the mode off and ran the full
 * image pipeline. Nothing threw anywhere along the way; the only symptom was a
 * toggle that appeared to do nothing.
 *
 * The insert hand-copies its params, so a field added to the schema but not to
 * that list fails exactly this silently. The assertion below covers the whole
 * settings set, not just the field that broke.
 */

import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { sequences, styles, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createSequencesMethods } from './sequences';

let client: Client;
let db: Database;
let teamId = '';
let userId = '';
let styleId = '';

async function seed() {
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('test setup: style insert returned nothing');
  styleId = style.id;
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

describe('sequences.create persists the chosen settings', () => {
  it('writes generateStartFrames rather than falling back to the column default', async () => {
    const methods = createSequencesMethods(db, teamId, userId);
    const created = await methods.create({
      title: 'Frame-based board',
      styleId,
      videoModel: 'minimax_h3_max',
      autoGenerateMotion: true,
      generateStartFrames: true,
    });

    expect(created.generateStartFrames).toBe(true);

    // Read it back: `returning()` could report a value the row does not hold.
    const [row] = await db.select().from(sequences);
    expect(row?.generateStartFrames).toBe(true);
  });

  it('defaults to off when the caller omits it', async () => {
    const methods = createSequencesMethods(db, teamId, userId);
    const created = await methods.create({ title: 'Normal', styleId });
    expect(created.generateStartFrames).toBe(false);
  });

  it('carries every generation setting through, not just some', async () => {
    const methods = createSequencesMethods(db, teamId, userId);
    const created = await methods.create({
      title: 'Everything',
      styleId,
      aspectRatio: '9:16',
      analysisModel: 'openai/gpt-5.6-luna',
      imageModel: 'nano_banana_2_lite',
      videoModel: 'minimax_h3_max',
      musicModel: 'elevenlabs_music',
      autoGenerateMotion: true,
      autoGenerateMusic: true,
      generateStartFrames: false,
    });

    expect({
      aspectRatio: created.aspectRatio,
      analysisModel: created.analysisModel,
      imageModel: created.imageModel,
      videoModel: created.videoModel,
      musicModel: created.musicModel,
      autoGenerateMotion: created.autoGenerateMotion,
      autoGenerateMusic: created.autoGenerateMusic,
      generateStartFrames: created.generateStartFrames,
    }).toEqual({
      aspectRatio: '9:16',
      analysisModel: 'openai/gpt-5.6-luna',
      imageModel: 'nano_banana_2_lite',
      videoModel: 'minimax_h3_max',
      musicModel: 'elevenlabs_music',
      autoGenerateMotion: true,
      autoGenerateMusic: true,
      generateStartFrames: false,
    });
  });
});
