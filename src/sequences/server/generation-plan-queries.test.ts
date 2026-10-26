/**
 * The sequence page's D1 cost (#2082): a fixed number of queries per
 * sequence, however many shots, characters or locations it has. One query
 * is one round trip to the primary, 350–450 ms from Europe, so a count that
 * grows per entity is a page that does not load there.
 */
import { createTestDb } from '@/platform/server/db/test-d1';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// oxlint-disable-next-line boundaries/no-raw-db -- substitute the isolated in-memory DB at the factory boundary
import { getDb } from '#db-client';
import type { Database } from '@/platform/server/db/client';
// oxlint-disable-next-line boundaries/no-scoped-factory -- exercise the real repositories, not mocks
import { createScopedDb } from '@/platform/server/db/scoped';
import {
  characterSheetVariants,
  locationSheetVariants,
  sequenceLocationLinks,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
import {
  createTestCharacter,
  createTestLocation,
  createTestSequence,
  createTestShot,
  createTestUser,
} from '@/platform/server/test/seed';
import { personLocksOf } from '@/cast/server/person-lock';
import {
  readLookSheetStaleness,
  readReferenceStaleness,
} from '@/cast/server/production-staleness';
import { buildCharacterSheetDraft } from '@/cast/server/sheets/character-sheet-trigger';
import { buildRegenerateLocationSheetPayload } from '@/cast/server/sheets/location-sheet-trigger';
import { finishCharacterSheetPayload } from '@/cast/server/workflows/sheet-snapshots';
import { loadSceneFacets } from '@/shots/server/scene-facets';
import { loadSceneContextBySequence } from '@/shots/server/scene-script';
import { loadSequenceSegments } from '@/shots/server/sequence-segments';
import { loadShotMediaStates } from '@/shots/server/shot-media-staleness';
import {
  loadShotStalenessBatch,
  loadShotStalenessReads,
} from '@/shots/server/shot-staleness';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { computeGenerationPlan } from './generation-plan';

vi.mock('#db-client', () => ({ getDb: vi.fn() }));

let closeDb: () => Promise<void>;
let db: Database;
let queries: string[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb({
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  }));
  vi.mocked(getDb).mockReturnValue(db);
});
afterAll(() => closeDb());

/** A sequence with `n` shots, `n` characters with hashed sheets and `n` locations with hashed sheets. */
async function seed(n: number) {
  const user = await createTestUser();
  const sequence = await createTestSequence(user.teamId, user.id);
  const now = new Date();
  for (let i = 0; i < n; i++) {
    await createTestShot(sequence.id, i);
    const character = await createTestCharacter(
      sequence.id,
      `char-${i}`,
      `Character ${i}`
    );
    // A stamped sheet runs the whole verdict, as every real one does.
    await db
      .update(characterSheetVariants)
      .set({ inputHash: 'stamped' })
      .where(eq(characterSheetVariants.id, character.id));
    const location = await createTestLocation(user.teamId, `Location ${i}`);
    await db
      .update(locationSheetVariants)
      .set({ inputHash: 'stamped' })
      .where(eq(locationSheetVariants.id, location.id));
    await db.insert(sequenceLocationLinks).values({
      id: generateId(),
      sequenceId: sequence.id,
      locationId: location.id,
      scriptLocationId: `loc-${i}`,
      attached: true,
      createdAt: now,
    });
  }
  return { scopedDb: createScopedDb(user.teamId, user.id), sequence };
}

/** What each server function in the issue's table reads, minus its auth. */
const LOADERS: Record<
  string,
  (scopedDb: ScopedDb, sequence: Sequence) => Promise<unknown>
> = {
  getGenerationPlanFn: (scopedDb, sequence) =>
    computeGenerationPlan(scopedDb, sequence.id),
  getSequenceSegmentsFn: async (scopedDb, sequence) =>
    loadSequenceSegments(
      scopedDb,
      sequence,
      await scopedDb.shots.listBySequence(sequence.id)
    ),
  getSequenceCharactersFn: async (scopedDb, sequence) =>
    personLocksOf(scopedDb, await scopedDb.characters.list(sequence.id)),
  getScenesFn: (scopedDb, sequence) =>
    loadSceneContextBySequence(scopedDb, sequence.id),
  getSceneFacetMapsFn: (scopedDb, sequence) =>
    loadSceneFacets(scopedDb, sequence),
  getShotStalenessBatchFn: async (scopedDb, sequence) => {
    const shots = await scopedDb.shots.listBySequence(sequence.id);
    const loaded = await loadShotStalenessBatch(scopedDb, sequence);
    const frameIds = [...loaded.anchorsByShot.values()].map((f) => f.id);
    return Promise.all([
      loadShotStalenessReads(
        scopedDb,
        sequence.id,
        shots,
        shots.map((s) => s.id),
        frameIds,
        loaded.sceneContext
      ),
      loadShotMediaStates(scopedDb, sequence, shots),
    ]);
  },
};

async function countQueries(n: number) {
  const { scopedDb, sequence: created } = await seed(n);
  const sequence = await scopedDb.sequences.getById(created.id);
  if (!sequence) throw new Error('seeded sequence not found');
  const counts: Record<string, number> = {};
  for (const [name, load] of Object.entries(LOADERS)) {
    queries = [];
    await load(scopedDb, sequence);
    counts[name] = queries.length;
  }
  return counts;
}

describe('sequence page query counts (#2082)', () => {
  it('do not grow with shots, characters or locations', async () => {
    const small = await countQueries(2);
    const large = await countQueries(8);
    console.log(
      ['fn | 2 of each | 8 of each']
        .concat(
          Object.keys(LOADERS).map(
            (name) => `${name} | ${small[name]} | ${large[name]}`
          )
        )
        .join('\n')
    );
    expect(large).toEqual(small);
  });
});

describe('sheet verdicts (#2082)', () => {
  it('the batched plan agrees with the per-row reader, fresh and stale', async () => {
    const { scopedDb, sequence: created } = await seed(1);
    const sequence = await scopedDb.sequences.getById(created.id);
    if (!sequence) throw new Error('seeded sequence not found');
    const [character] = await scopedDb.characters.list(sequence.id);
    const [location] = await scopedDb.locations.list(sequence.id);
    if (!character || !location) throw new Error('seed is empty');
    const actor = { userId: scopedDb.userId, teamId: scopedDb.teamId };

    // Stamp both sheets with the hash a regenerate would write now.
    const { draft, isDefault, liveFace } = await buildCharacterSheetDraft({
      scopedDb,
      sequence,
      ...actor,
      character,
      lookId: character.lookId,
    });
    const characterHash = (
      await finishCharacterSheetPayload(draft, isDefault ? null : liveFace)
    ).snapshotInputHash;
    const locationHash = (
      await buildRegenerateLocationSheetPayload({
        scopedDb,
        sequence,
        ...actor,
        location,
      })
    ).snapshotInputHash;
    await db
      .update(characterSheetVariants)
      .set({ inputHash: characterHash })
      .where(eq(characterSheetVariants.id, character.id));
    await db
      .update(locationSheetVariants)
      .set({ inputHash: locationHash })
      .where(eq(locationSheetVariants.id, location.id));

    const verdicts = async () => {
      const plan = await computeGenerationPlan(scopedDb, sequence.id);
      const unit = (kind: string, id: string) =>
        plan.find((u) => u.kind === kind && u.id === id)?.state;
      return {
        character: {
          plan: unit('sheet:character', character.lookId),
          row: (
            await readLookSheetStaleness(
              scopedDb,
              sequence.id,
              character.id,
              character.lookId
            )
          ).status,
        },
        location: {
          plan: unit('sheet:location', location.id),
          row: (
            await readReferenceStaleness(
              scopedDb,
              sequence.id,
              'location',
              location.id
            )
          ).status,
        },
      };
    };
    expect(await verdicts()).toEqual({
      character: { plan: 'done', row: 'fresh' },
      location: { plan: 'done', row: 'fresh' },
    });

    await scopedDb.characters.updateBible(
      sequence.id,
      character.id,
      { physicalDescription: 'a new face' },
      { actorId: scopedDb.userId, source: 'edit' }
    );
    await scopedDb.locations.updateBible(
      sequence.id,
      location.id,
      { description: 'a new place' },
      { actorId: scopedDb.userId }
    );
    expect(await verdicts()).toEqual({
      character: { plan: 'stale', row: 'stale' },
      location: { plan: 'stale', row: 'stale' },
    });
  });
});
