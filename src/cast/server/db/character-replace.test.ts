import { clearVersionRows } from '@/platform/server/test/clear-version-rows';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { ValidationError } from '@/platform/errors';
import { matchSpeaker } from '@/cast/voice';
import {
  characterMentionedInPrompt,
  matchCharacterToShotTags,
} from '@/shots/scene-matching';
import {
  characters,
  organization,
  scenes,
  sequenceCast,
  sequenceEvents,
  sequences,
  shots,
  styles,
  user,
} from '@/platform/server/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCharactersMethods } from './characters';

let closeDb: () => Promise<void>;
let db: Database;
let sequenceId = '';
let organizationId = '';
let actorId = '';

const bible = {
  rendering: 'Photoreal live action',
  standardClothing: null,
};

async function seed() {
  await clearVersionRows(db);
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(characters);
  await db.delete(styles);
  await db.delete(organization);
  await db.delete(user);
  organizationId = generateId();
  sequenceId = generateId();
  actorId = generateId();
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: `t-${organizationId}` });
  await db
    .insert(user)
    .values({ id: actorId, name: 'U', email: `${actorId}@e.com` });
  const [style] = await db
    .insert(styles)
    .values({
      organizationId,
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
  if (!style) throw new Error('style');
  await db.insert(sequences).values({
    id: sequenceId,
    organizationId,
    title: 'S',
    styleId: style.id,
    script: 'MARLOE walks in.',
  });
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(seed);

describe('characters.replace', () => {
  it('re-points the slot and keeps the script name and tag', async () => {
    const methods = createCharactersMethods(db, organizationId);
    const slot = await methods.create(
      {
        sequenceId,
        characterId: 'char_marloe',
        name: 'Marloe',
        consistencyTag: 'marloe',
        ...bible,
      },
      { source: 'analysis', createdBy: null }
    );
    const ada = await methods.createForOrganization(
      { name: 'Ada', ...bible },
      { createdBy: actorId }
    );
    const replaced = await methods.replace(sequenceId, slot.id, ada.id, {
      actorId,
    });
    expect(replaced.id).toBe(ada.id);
    expect(replaced.characterId).toBe('char_marloe');
    expect(replaced.name).toBe('Ada');
    expect(replaced.scriptName).toBe('Marloe');
    expect(replaced.consistencyTag).toBe('marloe');
    expect(matchCharacterToShotTags(replaced, ['marloe'])).toBe(true);
    expect(characterMentionedInPrompt(replaced, 'MARLOE walks in.')).toBe(true);
    expect(await methods.getById(sequenceId, slot.id)).toBeNull();
    expect(await methods.getCurrent(slot.id)).not.toBeNull();
    const [script] = await db
      .select({ script: sequences.script })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(script?.script).toBe('MARLOE walks in.');

    const bob = await methods.createForOrganization(
      { name: 'Bob', ...bible },
      { createdBy: actorId }
    );
    const again = await methods.replace(sequenceId, ada.id, bob.id, {
      actorId,
    });
    expect(again.id).toBe(bob.id);
    expect(again.scriptName).toBe('Marloe');
    expect(again.consistencyTag).toBe('marloe');
    expect(again.characterId).toBe('char_marloe');
  });

  it('drops a duplicate slot and remembers it on the one that stays', async () => {
    const methods = createCharactersMethods(db, organizationId);
    const marlow = await methods.create(
      {
        sequenceId,
        characterId: 'char_marlow',
        name: 'Marlow',
        consistencyTag: 'marlow',
        ...bible,
      },
      { source: 'analysis', createdBy: null }
    );
    const marloe = await methods.create(
      {
        sequenceId,
        characterId: 'char_marloe',
        name: 'Marloe',
        consistencyTag: 'marloe',
        ...bible,
      },
      { source: 'analysis', createdBy: null }
    );
    const replaced = await methods.replace(sequenceId, marloe.id, marlow.id, {
      actorId,
    });
    expect(replaced.id).toBe(marlow.id);
    expect(replaced.aliases).toEqual([
      {
        characterId: 'char_marloe',
        name: 'Marloe',
        consistencyTag: 'marloe',
      },
    ]);
    expect(matchCharacterToShotTags(replaced, ['marloe'])).toBe(true);
    expect(matchSpeaker('Marloe', [replaced])?.id).toBe(marlow.id);
    expect(await methods.getById(sequenceId, marloe.id)).toBeNull();
    expect(await methods.getCurrent(marloe.id)).not.toBeNull();
    expect(
      (await methods.getByCharacterId(sequenceId, 'char_marloe'))?.id
    ).toBe(marlow.id);
    expect(await methods.list(sequenceId)).toHaveLength(1);
    const events = await db
      .select({ kind: sequenceEvents.kind })
      .from(sequenceEvents)
      .where(eq(sequenceEvents.sequenceId, sequenceId));
    expect(events.some((event) => event.kind === 'character.replaced')).toBe(
      true
    );
  });

  it('deletes a removed link to the replacement before re-pointing', async () => {
    const methods = createCharactersMethods(db, organizationId);
    const slot = await methods.create(
      {
        sequenceId,
        characterId: 'char_marloe',
        name: 'Marloe',
        consistencyTag: 'marloe',
        ...bible,
      },
      { source: 'analysis', createdBy: null }
    );
    const ada = await methods.create(
      {
        sequenceId,
        characterId: 'char_ada',
        name: 'Ada',
        consistencyTag: 'ada',
        ...bible,
      },
      { source: 'analysis', createdBy: null }
    );
    await methods.softDelete(sequenceId, ada.id, { actorId });
    await methods.replace(sequenceId, slot.id, ada.id, { actorId });
    const links = await db
      .select({
        characterId: sequenceCast.characterId,
        scriptCharacterId: sequenceCast.scriptCharacterId,
      })
      .from(sequenceCast)
      .where(eq(sequenceCast.sequenceId, sequenceId));
    expect(links).toEqual([
      { characterId: ada.id, scriptCharacterId: 'char_marloe' },
    ]);
  });

  it('refuses to replace a character with itself', async () => {
    const methods = createCharactersMethods(db, organizationId);
    const slot = await methods.create(
      {
        sequenceId,
        characterId: 'char_ada',
        name: 'Ada',
        ...bible,
      },
      { source: 'analysis', createdBy: null }
    );
    await expect(
      methods.replace(sequenceId, slot.id, slot.id, { actorId })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
