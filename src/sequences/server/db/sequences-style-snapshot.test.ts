/**
 * Sequence-owned style snapshot: create/style-change copy the catalog recipe
 * so later catalog edits cannot stale existing sequences.
 */
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  characters,
  sequenceLocations,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { createCharactersMethods } from '@/cast/server/db/characters';
import { createCharacterLooksMethods } from '@/cast/server/db/character-looks';
import { createSequenceLocationsMethods } from '@/cast/server/db/sequence-locations';
import { createSequencesMethods } from './sequences';
import { isStyleConfigV2, parseStyleConfig } from '@/look/style-config';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const V1_A = {
  mood: 'tense and paranoid',
  artStyle: 'high-contrast neo-noir',
  lighting: 'low-key with hard shadows',
  colorPalette: ['#0a0a14', '#e8322f'],
  cameraWork: 'slow dolly, dutch angles',
  referenceFilms: ['rain-slicked neon-noir cityscapes'],
  colorGrading: 'crushed blacks, neon accents',
};

const V1_B = {
  ...V1_A,
  mood: 'bright and playful energy',
  artStyle: 'clean commercial product photography',
};

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
  await clearVersionRows(db);
  // Nothing cascades from a sequence to its characters (#2017).
  await db.delete(characters);
  await db.delete(sequenceLocations);
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

async function insertStyle(name: string, config: typeof V1_A) {
  const [row] = await db
    .insert(styles)
    .values({ teamId, name, config })
    .returning();
  if (!row) throw new Error('style insert returned nothing');
  return row;
}

describe('createSequencesMethods style snapshot', () => {
  it('copies a parsed v2 recipe onto the sequence at create', async () => {
    const style = await insertStyle('Noir', V1_A);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      generationStopAt: 'images',
      title: 'S',
      styleId: style.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(sequence.styleConfig).toBeTruthy();
    expect(isStyleConfigV2(sequence.styleConfig)).toBe(true);
    expect(parseStyleConfig(sequence.styleConfig).look.mood).toBe(V1_A.mood);
  });

  it('keeps the snapshot when the catalog row is later edited', async () => {
    const style = await insertStyle('Noir', V1_A);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      generationStopAt: 'images',
      title: 'S',
      styleId: style.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await db
      .update(styles)
      .set({ config: V1_B })
      .where(eq(styles.id, style.id));

    const reread = await methods.getById(sequence.id);
    expect(parseStyleConfig(reread?.styleConfig).look.mood).toBe(V1_A.mood);
  });

  it('replaces the snapshot when the sequence changes style', async () => {
    const styleA = await insertStyle('Noir', V1_A);
    const styleB = await insertStyle('Product', V1_B);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      generationStopAt: 'images',
      title: 'S',
      styleId: styleA.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const updated = await methods.update({
      id: sequence.id,
      styleId: styleB.id,
    });
    expect(parseStyleConfig(updated.styleConfig).look.mood).toBe(V1_B.mood);
  });

  it('keeps every snapshot as a version and points at the live one (#1600)', async () => {
    const styleA = await insertStyle('Noir', V1_A);
    const styleB = await insertStyle('Product', V1_B);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      generationStopAt: 'images',
      title: 'S',
      styleId: styleA.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const updated = await methods.update({
      id: sequence.id,
      styleId: styleB.id,
    });

    const versions = await methods.listStyleVersions(sequence.id);
    expect(versions.map((v) => [v.source, v.styleId])).toEqual([
      ['created', styleA.id],
      ['switched', styleB.id],
    ]);
    expect(updated.selectedStyleVersionId).toBe(versions[1]?.id);
    expect(parseStyleConfig(versions[0]?.config).look.mood).toBe(V1_A.mood);
  });

  // Sheet claims go only when the style write moves the snapshot (#1863).
  async function claimedLocation(styleId: string, deferStyleSnapshot = false) {
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      generationStopAt: 'images',
      title: 'S',
      styleId,
      deferStyleSnapshot,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const locations = createSequenceLocationsMethods(db);
    const location = await locations.create(
      { sequenceId: sequence.id, locationId: 'loc_001', name: 'Diner' },
      { source: 'analysis', createdBy: null }
    );
    const { versionId: locationClaim } = await locations.claimReference(
      location.id,
      {
        bibleVersionId: location.selectedBibleVersionId,
        libraryLocationId: null,
        styleVersionId: sequence.selectedStyleVersionId,
      },
      { markGenerating: true }
    );
    // A character's sheet claim is on its cast look (#2017).
    const characters = createCharactersMethods(db, teamId);
    const character = await characters.create(
      { sequenceId: sequence.id, characterId: 'char_001', name: 'Ada' },
      { source: 'analysis', createdBy: null }
    );
    const sheet = await createCharacterLooksMethods(db, teamId).claimSheet(
      sequence.id,
      character.lookId,
      {
        lookVersionId: character.looks[0]?.lookVersionId ?? '',
        bibleVersionId: character.selectedBibleVersionId,
        talentId: character.talentId,
        styleVersionId: sequence.selectedStyleVersionId,
      },
      { markGenerating: true }
    );
    if (!sheet.held) throw new Error('test setup: sheet claim not taken');
    const claim = { location: locationClaim, sheet: sheet.versionId };
    const liveClaim = async () => ({
      location:
        (await locations.getById(location.id))
          ?.pendingPromoteReferenceVersionId ?? null,
      sheet:
        (await characters.getById(sequence.id, character.id))
          ?.pendingPromoteSheetVersionId ?? null,
    });
    return { methods, sequence, claim, liveClaim };
  }

  it('revokes sheet claims taken before the automatic style lands', async () => {
    // A character and a location added by hand, their sheets generating
    // against the placeholder recipe, while the first analysis derives the
    // real one.
    const style = await insertStyle('Auto', V1_A);
    const { methods, sequence, claim, liveClaim } = await claimedLocation(
      style.id,
      true
    );
    expect(await liveClaim()).toEqual(claim);
    expect(
      await methods.snapshotAutoStyle({ id: sequence.id, styleId: style.id })
    ).toBe(true);
    expect(await liveClaim()).toEqual({ location: null, sheet: null });
  });

  it('keeps sheet claims when the automatic style no longer lands', async () => {
    // The sequence was re-styled mid-run: the derived recipe is not
    // snapshotted, so it revokes nothing.
    const auto = await insertStyle('Auto', V1_A);
    const picked = await insertStyle('Product', V1_B);
    const { methods, sequence, claim, liveClaim } = await claimedLocation(
      picked.id
    );
    expect(
      await methods.snapshotAutoStyle({ id: sequence.id, styleId: auto.id })
    ).toBe(false);
    expect(await liveClaim()).toEqual(claim);
  });

  it('keeps sheet claims when the same style is saved again', async () => {
    const style = await insertStyle('Noir', V1_A);
    const { methods, sequence, claim, liveClaim } = await claimedLocation(
      style.id
    );
    await methods.update({ id: sequence.id, styleId: style.id, title: 'T' });
    expect(await liveClaim()).toEqual(claim);
  });

  it('revokes sheet claims when the style switches', async () => {
    const styleA = await insertStyle('Noir', V1_A);
    const styleB = await insertStyle('Product', V1_B);
    const { methods, sequence, liveClaim } = await claimedLocation(styleA.id);
    await methods.update({ id: sequence.id, styleId: styleB.id });
    expect(await liveClaim()).toEqual({ location: null, sheet: null });
  });

  it('revokes sheet claims when the same style is re-saved with an edited recipe', async () => {
    const style = await insertStyle('Noir', V1_A);
    const { methods, sequence, liveClaim } = await claimedLocation(style.id);
    await db
      .update(styles)
      .set({ config: V1_B })
      .where(eq(styles.id, style.id));
    await methods.update({ id: sequence.id, styleId: style.id });
    expect(await liveClaim()).toEqual({ location: null, sheet: null });
  });

  it('a deferred snapshot has no version until the automatic style lands', async () => {
    const style = await insertStyle('Auto', V1_A);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      generationStopAt: 'images',
      title: 'S',
      styleId: style.id,
      deferStyleSnapshot: true,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    expect(sequence.styleConfig).toBeNull();
    expect(await methods.listStyleVersions(sequence.id)).toEqual([]);

    expect(
      await methods.snapshotAutoStyle({ id: sequence.id, styleId: style.id })
    ).toBe(true);
    const [derived] = await methods.listStyleVersions(sequence.id);
    expect(derived?.source).toBe('derived');
    expect((await methods.getById(sequence.id))?.selectedStyleVersionId).toBe(
      derived?.id
    );
  });
});
