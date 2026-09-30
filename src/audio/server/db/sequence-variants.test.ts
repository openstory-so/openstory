/**
 * The music claim lifecycle on `sequence_music_variants` (#1115, #1130) and
 * the read projection it drives, against a migrated in-memory libSQL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import { sequenceMusicInputHash } from '@/shots/input-hash';
import {
  sequenceMusicVariants,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { Database } from '@/platform/server/db/client';
import { createSequenceVariantsMethods } from './sequence-variants';
import { selectSequencesFrom } from '@/sequences/server/db/sequences';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';

async function seed() {
  await db.delete(sequenceMusicVariants);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();
  sequenceId = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
  const [style] = await db
    .insert(styles)
    .values({
      teamId: team.id,
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
  await db
    .insert(sequences)
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
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

const track = {
  model: 'cassette',
  prompt: 'p',
  tags: 't',
  durationSeconds: 30,
};
const landing = (url: string) => ({
  sequenceId,
  url,
  storagePath: url.replace('/r2/audio/', ''),
  durationSeconds: 30,
  inputHash: sequenceMusicInputHash('h'),
});
const readSequence = async () => {
  const [row] = await selectSequencesFrom(db).where(
    eq(sequences.id, sequenceId)
  );
  if (!row) throw new Error('sequence missing');
  return row;
};

describe('music claim lifecycle (#1115)', () => {
  it('claim → complete moves the pointer, consumes the claim, and projects the track', async () => {
    const methods = createSequenceVariantsMethods(db);
    const id = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: 'run-1',
    });
    if (!id) throw new Error('claim returned null');
    expect((await readSequence()).musicStatus).toBe('generating');

    const landed = await methods.completeMusicClaim(
      id,
      landing('/r2/audio/a.mp3')
    );
    expect(landed.status).toBe('completed');
    expect(landed.divergedAt).toBeNull();

    const seq = await readSequence();
    expect(seq.selectedMusicVariantId).toBe(id);
    expect(seq.pendingPromoteMusicVariantId).toBeNull();
    expect(seq.musicStatus).toBe('completed');
    expect(seq.musicUrl).toBe('/r2/audio/a.mp3');
    expect(seq.musicPath).toBe('a.mp3');
  });

  it('a replayed completion changes nothing', async () => {
    const methods = createSequenceVariantsMethods(db);
    const id = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
    });
    if (!id) throw new Error('claim returned null');
    const first = await methods.completeMusicClaim(
      id,
      landing('/r2/audio/a.mp3')
    );
    const again = await methods.completeMusicClaim(
      id,
      landing('/r2/audio/b.mp3')
    );
    expect(again).toEqual(first);
    expect((await readSequence()).musicUrl).toBe('/r2/audio/a.mp3');
  });

  it('a run whose claim a newer kickoff took lands parked, pointer untouched', async () => {
    const methods = createSequenceVariantsMethods(db);
    const older = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
    });
    const newer = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
    });
    if (!older || !newer) throw new Error('claim returned null');

    const parked = await methods.completeMusicClaim(
      older,
      landing('/r2/audio/old.mp3')
    );
    expect(parked.divergedAt).not.toBeNull();
    let seq = await readSequence();
    expect(seq.selectedMusicVariantId).toBeNull();
    expect(seq.pendingPromoteMusicVariantId).toBe(newer);
    expect(seq.musicStatus).toBe('generating');

    await methods.completeMusicClaim(newer, landing('/r2/audio/new.mp3'));
    seq = await readSequence();
    expect(seq.selectedMusicVariantId).toBe(newer);
    expect(seq.musicUrl).toBe('/r2/audio/new.mp3');
    expect(
      (await methods.listDivergentMusic(sequenceId)).map((v) => v.id)
    ).toEqual([older]);
  });

  it('ifPendingIs: null takes the claim only while no run holds it', async () => {
    const methods = createSequenceVariantsMethods(db);
    const first = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
      ifPendingIs: null,
    });
    const busy = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
      ifPendingIs: null,
    });
    expect(first).not.toBeNull();
    expect(busy).toBeNull();
    // A lost compare-and-swap opens no row.
    expect(await methods.listMusicBySequence(sequenceId)).toHaveLength(1);
  });

  it('failure fails the row and clears only its own claim', async () => {
    const methods = createSequenceVariantsMethods(db);
    const older = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: 'run-old',
    });
    const newer = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: 'run-new',
    });
    if (!older || !newer) throw new Error('claim returned null');

    await methods.failMusicClaim({ sequenceId, workflowRunId: 'run-old' }, 'x');
    expect((await methods.getMusicById(older))?.status).toBe('failed');
    expect((await readSequence()).pendingPromoteMusicVariantId).toBe(newer);

    await methods.failMusicClaim({ sequenceId, variantId: newer }, 'boom');
    const seq = await readSequence();
    expect(seq.pendingPromoteMusicVariantId).toBeNull();
    expect(seq.musicStatus).toBe('failed');
    expect(seq.musicError).toBe('boom');
  });

  it('failure with no row of the run records one when asked', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.failMusicClaim(
      { sequenceId, workflowRunId: 'dead', recordIfMissing: { model: 'x' } },
      'died early'
    );
    const rows = await methods.listMusicBySequence(sequenceId);
    expect(rows.map((r) => [r.status, r.error, r.isPrimary])).toEqual([
      ['failed', 'died early', true],
    ]);
    // A completed row of the run is never overwritten nor duplicated.
    const id = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: 'done',
    });
    if (!id) throw new Error('claim returned null');
    await methods.completeMusicClaim(id, landing('/r2/audio/a.mp3'));
    await methods.failMusicClaim(
      { sequenceId, workflowRunId: 'done', recordIfMissing: { model: 'x' } },
      'late'
    );
    expect((await methods.getMusicById(id))?.status).toBe('completed');
    expect(await methods.listMusicBySequence(sequenceId)).toHaveLength(2);
  });

  it('an added model opens its row with no claim and never touches the sequence', async () => {
    const methods = createSequenceVariantsMethods(db);
    const id = await methods.claimMusic({
      sequenceId,
      ...track,
      model: 'other',
      isPrimary: false,
      workflowRunId: null,
    });
    if (!id) throw new Error('claim returned null');
    expect((await readSequence()).musicStatus).toBe('pending');
    await methods.completeMusicClaim(id, landing('/r2/audio/o.mp3'));
    const seq = await readSequence();
    expect(seq.selectedMusicVariantId).toBeNull();
    expect((await methods.getMusicById(id))?.divergedAt).toBeNull();
    expect(await methods.listMusicModels(sequenceId)).toEqual(['other']);
  });

  it('selectMusic points at a finished track, un-parks it and clears the claim', async () => {
    const methods = createSequenceVariantsMethods(db);
    const older = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
    });
    const newer = await methods.claimMusic({
      sequenceId,
      ...track,
      isPrimary: true,
      workflowRunId: null,
    });
    if (!older || !newer) throw new Error('claim returned null');
    await methods.completeMusicClaim(older, landing('/r2/audio/old.mp3'));

    const seq = await methods.selectMusic(sequenceId, older);
    expect(seq.selectedMusicVariantId).toBe(older);
    expect(seq.pendingPromoteMusicVariantId).toBeNull();
    expect((await methods.getMusicById(older))?.divergedAt).toBeNull();
    // The in-flight run now lands parked (rule 4).
    const late = await methods.completeMusicClaim(
      newer,
      landing('/r2/audio/new.mp3')
    );
    expect(late.divergedAt).not.toBeNull();
    expect((await readSequence()).musicUrl).toBe('/r2/audio/old.mp3');

    await expect(methods.selectMusic(sequenceId, generateId())).rejects.toThrow(
      /not found/
    );
  });

  it('an upload is a selected completed track; earlier uploads park as alternates', async () => {
    const methods = createSequenceVariantsMethods(db);
    const upload = (url: string) =>
      methods.appendUploadedMusic({
        sequenceId,
        model: 'user-upload',
        url,
        storagePath: url,
        prompt: null,
        tags: null,
        durationSeconds: null,
      });
    const first = await upload('/r2/audio/u1.mp3');
    const second = await upload('/r2/audio/u2.mp3');
    const seq = await readSequence();
    expect(seq.selectedMusicVariantId).toBe(second.id);
    expect(seq.musicStatus).toBe('completed');
    expect((await methods.getMusicById(first.id))?.url).toBe(
      '/r2/audio/u1.mp3'
    );
    expect(
      (await methods.listDivergentMusic(sequenceId)).map((v) => v.id)
    ).toEqual([first.id]);
  });
});

describe('listDivergentByTeam', () => {
  it('excludes variants belonging to a different team and excludes discarded rows', async () => {
    const methods = createSequenceVariantsMethods(db);

    // Build a second team with its own sequence sharing the same style.
    const otherTeamId = generateId();
    await db.insert(teams).values({
      id: otherTeamId,
      name: 'Other',
      slug: 'other',
    });
    const [otherStyle] = await db
      .insert(styles)
      .values({
        teamId: otherTeamId,
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
    if (!otherStyle)
      throw new Error('test setup: otherStyle insert returned nothing');
    const otherSequenceId = generateId();
    await db.insert(sequences).values({
      id: otherSequenceId,
      teamId: otherTeamId,
      title: 'Other',
      styleId: otherStyle.id,
    });

    // Add a second sequence on the seed team so we can test the
    // "two sequences => two rows" axis.
    const secondSeedSequenceId = generateId();
    const [seedStyle] = await db
      .select()
      .from(styles)
      .where(eq(styles.teamId, team.id));
    if (!seedStyle)
      throw new Error('test setup: seedStyle lookup returned nothing');
    await db.insert(sequences).values({
      id: secondSeedSequenceId,
      teamId: team.id,
      title: 'S2',
      styleId: seedStyle.id,
    });

    const divergedAt = new Date('2026-04-29T00:00:00Z');

    // Live divergent music on the seed team's primary sequence.
    await db.insert(sequenceMusicVariants).values({
      sequenceId,
      model: 'cassette',
      url: 'https://example.com/m-divergent.mp3',
      status: 'completed',
      inputHash: 'm-hash',
      divergedAt,
    });

    // Live divergent music on the second seed-team sequence (separate row).
    await db.insert(sequenceMusicVariants).values({
      sequenceId: secondSeedSequenceId,
      model: 'cassette',
      url: 'https://example.com/m2-divergent.mp3',
      status: 'completed',
      inputHash: 'm2-hash',
      divergedAt,
    });

    // Discarded divergent music on the seed team — must be excluded.
    await db.insert(sequenceMusicVariants).values({
      sequenceId: secondSeedSequenceId,
      model: 'cassette',
      url: 'https://example.com/m-discarded.mp3',
      status: 'completed',
      inputHash: 'discarded-hash',
      divergedAt,
      discardedAt: new Date('2026-04-30T00:00:00Z'),
    });

    // Live divergent music on the OTHER team — must be excluded by team scope.
    await db.insert(sequenceMusicVariants).values({
      sequenceId: otherSequenceId,
      model: 'cassette',
      url: 'https://example.com/other.mp3',
      status: 'completed',
      inputHash: 'other-hash',
      divergedAt,
    });

    const rows = await methods.listDivergentByTeam(team.id);
    const byId = new Map(rows.map((r) => [r.sequenceId, r]));

    expect(rows).toHaveLength(2);
    expect(byId.get(sequenceId)).toEqual({
      sequenceId,
      hasMusic: true,
    });
    expect(byId.get(secondSeedSequenceId)).toEqual({
      sequenceId: secondSeedSequenceId,
      hasMusic: true,
    });
    // Other team's sequence must not appear.
    expect(byId.has(otherSequenceId)).toBe(false);
  });
});
