/**
 * Scoped `sequences.create` must write app-level model defaults, not the
 * stale SQL column literals (#1116 / imageModel+videoModel pattern).
 */

import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { sequences, styles, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSequencesMethods } from './sequences';

let client: Client;
let db: Database;
let teamId = '';
let userId = '';
let styleId = '';

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
  await db.insert(user).values({
    id: userId,
    name: 'U',
    email: `${userId}@example.com`,
  });
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
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
});

describe('sequences.create model defaults', () => {
  it('does not change the SQL column default for analysisModel', async () => {
    const id = generateId();
    await db.insert(sequences).values({
      id,
      teamId,
      title: 'raw',
      styleId,
    });
    const [row] = await db
      .select({ analysisModel: sequences.analysisModel })
      .from(sequences)
      .where(eq(sequences.id, id));
    expect(row?.analysisModel).toBe('anthropic/claude-haiku-4.5');
    expect(row?.analysisModel).not.toBe(DEFAULT_ANALYSIS_MODEL);
  });

  it('substitutes app-level defaults when models are omitted', async () => {
    const methods = createSequencesMethods(db, teamId, userId);
    const created = await methods.create({
      title: 'omitted',
      styleId,
    });
    expect(created.analysisModel).toBe(DEFAULT_ANALYSIS_MODEL);
    expect(created.imageModel).toBe(DEFAULT_IMAGE_MODEL);
    expect(created.videoModel).toBe(DEFAULT_VIDEO_MODEL);
  });

  it('persists an explicit analysisModel', async () => {
    const methods = createSequencesMethods(db, teamId, userId);
    const created = await methods.create({
      title: 'explicit',
      styleId,
      analysisModel: 'anthropic/claude-sonnet-4.6',
    });
    expect(created.analysisModel).toBe('anthropic/claude-sonnet-4.6');
  });
});
