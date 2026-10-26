/**
 * `scopedDb.locations` (#1695): a location belongs to the team and a sequence
 * uses one through a link. In-memory libSQL with the real migrations.
 *
 * What is pinned here:
 *   - a read through a sequence answers with the link's own fields;
 *   - every method that takes an id is scoped to the team;
 *   - attach, replace, the two deletes and restore;
 *   - reference photos and bible edits revoke a sheet run's claim only when
 *     an input of the sheet moved;
 *   - `rendering` is required on every bible write;
 *   - the team list's order.
 *
 * Analysis (`createBulk`) is in `locations-create-bulk.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import type { SequenceLocationWithReference } from '@/platform/server/db/schema';
import {
  locationBibleVersions,
  locationReferencePhotos,
  locations,
  locationSheetVariants,
  sequenceEvents,
  sequenceLocationLinks,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';
import { createSequencesMethods } from '@/sequences/server/db/sequences';
import { matchLocationsToScene } from '@/shots/scene-matching';
import { createLocationsMethods } from './locations';

let closeDb: () => Promise<void>;
let db: Database;
let teamId = '';
let otherTeamId = '';
let actorId = '';
/** Two sequences of the team, and one of another team. */
let sequenceId = '';
let secondSequenceId = '';
let otherTeamSequenceId = '';

const STYLE = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

const analysis = { source: 'analysis' as const, createdBy: null };

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await clearVersionRows(db);
  await db.delete(sequenceEvents);
  await db.delete(locations);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  otherTeamId = generateId();
  actorId = generateId();
  sequenceId = generateId();
  secondSequenceId = generateId();
  otherTeamSequenceId = generateId();
  await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });
  await db.insert(teams).values([
    { id: teamId, name: 'T', slug: 't' },
    { id: otherTeamId, name: 'O', slug: 'o' },
  ]);
  const [style, otherStyle] = await db
    .insert(styles)
    .values([
      { teamId, name: 'default', config: STYLE },
      { teamId: otherTeamId, name: 'default', config: STYLE },
    ])
    .returning();
  if (!style || !otherStyle) throw new Error('test setup: no style');
  await db.insert(sequences).values([
    { id: sequenceId, teamId, title: 'One', styleId: style.id },
    { id: secondSequenceId, teamId, title: 'Two', styleId: style.id },
    {
      id: otherTeamSequenceId,
      teamId: otherTeamId,
      title: 'Theirs',
      styleId: otherStyle.id,
    },
  ]);
});

const locs = () => createLocationsMethods(db, teamId);
const theirs = () => createLocationsMethods(db, otherTeamId);

/** A location analysis made in a sequence of the team. */
const analysed = (name: string, scriptId = 'loc_001', seq = sequenceId) =>
  locs().create(
    {
      sequenceId: seq,
      locationId: scriptId,
      name,
      rendering: PHOTOREAL_RENDERING,
    },
    analysis
  );

/** A location made on the Locations page: no link. */
const teamLocation = (name: string) =>
  locs().createForTeam(
    { name, rendering: PHOTOREAL_RENDERING },
    { createdBy: actorId }
  );

const linksOf = (seq = sequenceId) =>
  db
    .select()
    .from(sequenceLocationLinks)
    .where(eq(sequenceLocationLinks.sequenceId, seq));

const rowOf = async (id: string) => {
  const [row] = await db.select().from(locations).where(eq(locations.id, id));
  if (!row) throw new Error('location row gone');
  return row;
};

const eventKinds = async () =>
  (await db.select().from(sequenceEvents)).map((event) => event.kind);

describe('a location added by hand', () => {
  it('attaches the link so analysis cannot rewrite it', async () => {
    const created = await locs().create(
      {
        sequenceId,
        locationId: 'loc_hand',
        name: 'Office',
        rendering: PHOTOREAL_RENDERING,
      },
      { source: 'edit', createdBy: actorId }
    );
    expect(created.attached).toBe(true);
  });
});

describe('a read through a sequence', () => {
  it("answers with the link's script id, first mention and remove", async () => {
    const created = await locs().create(
      {
        sequenceId,
        locationId: 'loc_001',
        name: 'Diner',
        rendering: PHOTOREAL_RENDERING,
        firstMentionSceneId: 'scene_001',
        firstMentionText: 'INT. DINER',
        firstMentionLine: 3,
      },
      analysis
    );
    const [link] = await linksOf();

    expect(created).toMatchObject({
      linkId: link?.id,
      sequenceId,
      locationId: 'loc_001',
      firstMentionSceneId: 'scene_001',
      firstMentionText: 'INT. DINER',
      firstMentionLine: 3,
      attached: false,
      deletedAt: null,
      teamId,
      name: 'Diner',
      rendering: PHOTOREAL_RENDERING,
    });
    expect(await locs().getByLocationId(sequenceId, 'loc_001')).toMatchObject({
      id: created.id,
    });

    await locs().softDelete(sequenceId, created.id, { actorId });
    // `deletedAt` on a linked read is the link's `removedAt` (stored to the
    // second)...
    const removedAt = (await linksOf())[0]?.removedAt;
    expect(removedAt).toBeInstanceOf(Date);
    expect((await locs().getById(sequenceId, created.id))?.deletedAt).toEqual(
      removedAt
    );
    // ...and the location itself is not deleted from the team.
    expect((await rowOf(created.id)).deletedAt).toBeNull();
    expect((await locs().getCurrent(created.id))?.deletedAt).toBeNull();
    expect(await locs().list(sequenceId)).toEqual([]);
    expect(
      (await locs().listDeleted(sequenceId)).map((location) => location.id)
    ).toEqual([created.id]);
  });

  it('is null from a sequence that does not use the location', async () => {
    const created = await analysed('Diner');
    expect(await locs().getById(secondSequenceId, created.id)).toBeNull();
    expect(await locs().get(secondSequenceId, created.id)).toBeNull();
    expect((await locs().get(null, created.id))?.id).toBe(created.id);
  });
});

describe("another team's location", () => {
  it('is not readable by id', async () => {
    const linked = await analysed('Diner');
    await locs().addPhotos(linked.id, [{ url: '/r2/a.png', path: 'a.png' }]);

    expect(await theirs().getById(sequenceId, linked.id)).toBeNull();
    expect(await theirs().getByLocationId(sequenceId, 'loc_001')).toBeNull();
    expect(await theirs().getByIds(sequenceId, [linked.id])).toEqual([]);
    expect(await theirs().list(sequenceId)).toEqual([]);
    expect(await theirs().listWithReferences(sequenceId)).toEqual([]);
    expect(await theirs().getCurrent(linked.id)).toBeNull();
    expect(await theirs().getCurrentByIds([linked.id])).toEqual([]);
    expect(await theirs().get(null, linked.id)).toBeNull();
    expect(await theirs().get(sequenceId, linked.id)).toBeNull();
    expect(await theirs().getTeamLocation(linked.id)).toBeNull();
    expect(await theirs().listTeam()).toEqual([]);
    expect(await theirs().listBibleVersions(linked.id)).toEqual([]);
    expect(await theirs().listBibleVersionsBySequence(sequenceId)).toEqual([]);
    expect(await theirs().listPhotos(linked.id)).toEqual([]);
    expect(await theirs().getUsedInAnySequenceOrArchive(linked.id)).toBe(false);
    expect(await theirs().getShotIdsForLocation(sequenceId, linked.id)).toEqual(
      []
    );
  });

  it('is not writable by id', async () => {
    const linked = await analysed('Diner');
    const unlinked = await teamLocation('Depot');
    const own = await theirs().createForTeam(
      { name: 'Their Yard', rendering: PHOTOREAL_RENDERING },
      { createdBy: actorId }
    );
    const ownLinked = await theirs().attach(otherTeamSequenceId, own.id, {
      actorId,
    });
    const claim = await locs().claimReference(linked.id, {
      markGenerating: true,
    });
    const before = await rowOf(linked.id);

    await expect(
      theirs().updateBible(null, linked.id, { name: 'Mine' }, { actorId })
    ).rejects.toThrow('Location not found');
    await expect(
      theirs().updateBible(sequenceId, linked.id, { name: 'Mine' }, { actorId })
    ).rejects.toThrow('Location not found');
    await expect(
      theirs().claimReference(linked.id, { markGenerating: true })
    ).rejects.toThrow('Location not found');
    expect(
      (
        await theirs().claimReferenceIfUnmoved(linked.id, {
          bibleVersionId: before.selectedBibleVersionId ?? '',
        })
      ).held
    ).toBe(false);
    await theirs().failReferenceClaim(linked.id, claim, 'boom');
    await theirs().failReferenceClaim(linked.id, null, 'boom');
    await expect(
      theirs().addPhotos(linked.id, [{ url: '/r2/a.png', path: 'a.png' }])
    ).rejects.toThrow('Location not found');
    await expect(theirs().removePhoto(linked.id, generateId())).rejects.toThrow(
      'Location not found'
    );
    await expect(
      theirs().softDelete(sequenceId, linked.id, { actorId })
    ).rejects.toThrow('Location not found');
    await expect(
      theirs().restore(sequenceId, linked.id, { actorId })
    ).rejects.toThrow('Location not found');
    // Nothing links `unlinked`, so only the team stops this delete.
    expect(await theirs().softDeleteForTeam(unlinked.id)).toBe(false);
    // Into their own sequence, and into ours.
    await expect(
      theirs().attach(otherTeamSequenceId, unlinked.id, { actorId })
    ).rejects.toThrow('Location not found');
    await expect(
      theirs().attach(sequenceId, unlinked.id, { actorId })
    ).rejects.toThrow('Location not found');
    // Their own location replaced with ours, and ours replaced with theirs.
    await expect(
      theirs().replace(otherTeamSequenceId, ownLinked.id, unlinked.id, {
        actorId,
      })
    ).rejects.toThrow('Location not found');
    await expect(
      theirs().replace(sequenceId, linked.id, own.id, { actorId })
    ).rejects.toThrow('Location not found');

    // Nothing of ours moved: the row, its claim, its bible, its link.
    expect(await rowOf(linked.id)).toEqual(before);
    expect((await rowOf(linked.id)).pendingPromoteReferenceVersionId).toBe(
      claim
    );
    expect((await rowOf(unlinked.id)).deletedAt).toBeNull();
    expect(await locs().listPhotos(linked.id)).toEqual([]);
    expect(await locs().listBibleVersions(linked.id)).toHaveLength(1);
    expect(await linksOf()).toHaveLength(1);
    expect(await linksOf(otherTeamSequenceId)).toMatchObject([
      { locationId: own.id },
    ]);
  });

  it('is not brought back by their undo of a team delete', async () => {
    const unlinked = await teamLocation('Depot');
    expect(await locs().softDeleteForTeam(unlinked.id)).toBe(true);
    await theirs().restoreForTeam(unlinked.id);
    expect((await rowOf(unlinked.id)).deletedAt).toBeInstanceOf(Date);
  });
});

describe('attach', () => {
  it('links one of the team’s locations and copies nothing', async () => {
    const diner = await teamLocation("Mel's Diner");
    const attached = await locs().attach(sequenceId, diner.id, { actorId });

    expect(attached).toMatchObject({
      id: diner.id,
      sequenceId,
      locationId: 'loc_mel_s_diner',
      attached: true,
      deletedAt: null,
      selectedBibleVersionId: diner.selectedBibleVersionId,
    });
    expect(await db.select().from(locations)).toHaveLength(1);
    expect(await db.select().from(locationBibleVersions)).toHaveLength(1);
    expect(await eventKinds()).toEqual(['location.attached']);
  });

  it('is idempotent', async () => {
    const diner = await teamLocation('Diner');
    const first = await locs().attach(sequenceId, diner.id, { actorId });
    const second = await locs().attach(sequenceId, diner.id, { actorId });

    expect(second).toEqual(first);
    expect(await linksOf()).toHaveLength(1);
    expect(await eventKinds()).toEqual(['location.attached']);
  });

  it('gives a second location of one slug the next free script id', async () => {
    const first = await analysed('Old Place', 'loc_diner');
    const diner = await teamLocation('Diner');
    const attached = await locs().attach(sequenceId, diner.id, { actorId });
    expect(first.locationId).toBe('loc_diner');
    expect(attached.locationId).toBe('loc_diner_2');
  });

  it('brings a removed link back as attached', async () => {
    const diner = await analysed('Diner');
    expect(diner.attached).toBe(false);
    await locs().softDelete(sequenceId, diner.id, { actorId });

    const attached = await locs().attach(sequenceId, diner.id, { actorId });
    expect(attached).toMatchObject({
      linkId: diner.linkId,
      locationId: 'loc_001',
      attached: true,
      deletedAt: null,
    });
    expect(await linksOf()).toHaveLength(1);
  });

  it('refuses a name a live location of the sequence already has', async () => {
    await analysed('Diner');
    const twin = await teamLocation(' diner ');
    await expect(
      locs().attach(sequenceId, twin.id, { actorId })
    ).rejects.toThrow(/already a location in this sequence/);
    expect(await linksOf()).toHaveLength(1);

    // The same check before a removed link comes back.
    const removed = await analysed('Depot', 'loc_002');
    await locs().softDelete(sequenceId, removed.id, { actorId });
    await analysed('DEPOT', 'loc_003');
    await expect(
      locs().attach(sequenceId, removed.id, { actorId })
    ).rejects.toThrow(/already a location in this sequence/);
    expect(
      (await locs().getById(sequenceId, removed.id))?.deletedAt
    ).toBeInstanceOf(Date);
  });

  it('does not refuse a name only a removed location has', async () => {
    const old = await analysed('Diner');
    await locs().softDelete(sequenceId, old.id, { actorId });
    const twin = await teamLocation('Diner');
    await expect(
      locs().attach(sequenceId, twin.id, { actorId })
    ).resolves.toMatchObject({ id: twin.id });
  });

  it("refuses another team's sequence, and a sequence that does not exist", async () => {
    const diner = await teamLocation('Diner');
    await expect(
      locs().attach(otherTeamSequenceId, diner.id, { actorId })
    ).rejects.toThrow('Sequence not found');
    await expect(
      locs().attach(generateId(), diner.id, { actorId })
    ).rejects.toThrow('Sequence not found');
    expect(await db.select().from(sequenceLocationLinks)).toEqual([]);
  });

  it('refuses a location deleted from the team', async () => {
    const diner = await teamLocation('Diner');
    await locs().softDeleteForTeam(diner.id);
    await expect(
      locs().attach(sequenceId, diner.id, { actorId })
    ).rejects.toThrow('Location not found');
  });
});

describe('replace', () => {
  it('re-points the link and keeps its script id and the tag scenes carry', async () => {
    const old = await locs().create(
      {
        sequenceId,
        locationId: 'loc_001',
        name: 'Diner',
        rendering: PHOTOREAL_RENDERING,
        consistencyTag: 'diner_chrome',
        firstMentionText: 'INT. DINER',
      },
      analysis
    );
    const next = await locs().createForTeam(
      {
        name: 'Roadhouse',
        rendering: PHOTOREAL_RENDERING,
        consistencyTag: 'roadhouse_timber',
      },
      { createdBy: actorId }
    );

    const replaced = await locs().replace(sequenceId, old.id, next.id, {
      actorId,
    });

    expect(replaced).toMatchObject({
      id: next.id,
      name: 'Roadhouse',
      linkId: old.linkId,
      locationId: 'loc_001',
      firstMentionText: 'INT. DINER',
      attached: true,
      // Scenes were tagged for the place it replaced.
      consistencyTag: 'diner_chrome',
    });
    // A scene still carries the old place's tag and still finds the new one.
    const live = await locs().list(sequenceId);
    expect(
      matchLocationsToScene(live, 'diner_chrome', '').map((l) => l.id)
    ).toEqual([next.id]);
    // From no sequence the same location is not found by that tag.
    const own = await locs().getCurrent(next.id);
    if (!own) throw new Error('test setup: replacement not found');
    expect(
      matchLocationsToScene(
        [{ ...own, locationId: 'loc_001' }],
        'diner_chrome',
        ''
      )
    ).toEqual([]);
    expect(await linksOf()).toHaveLength(1);
    expect(await locs().getById(sequenceId, old.id)).toBeNull();
    // Both stay the team's, each with its own bible and tag.
    expect(await locs().getCurrent(old.id)).toMatchObject({
      name: 'Diner',
      consistencyTag: 'diner_chrome',
    });
    expect(await locs().getCurrent(next.id)).toMatchObject({
      consistencyTag: 'roadhouse_timber',
    });
    expect(await db.select().from(locationBibleVersions)).toHaveLength(2);
    expect(await eventKinds()).toEqual(['location.replaced']);
  });

  it('with itself changes nothing', async () => {
    const old = await analysed('Diner');
    expect(
      await locs().replace(sequenceId, old.id, old.id, { actorId })
    ).toEqual(old);
    expect(await eventKinds()).toEqual([]);
  });

  it('refuses a location already live in the sequence', async () => {
    const old = await analysed('Diner');
    const live = await analysed('Roadhouse', 'loc_002');
    await expect(
      locs().replace(sequenceId, old.id, live.id, { actorId })
    ).rejects.toThrow('Roadhouse is already a location in this sequence.');
    expect((await linksOf()).map((link) => link.locationId).sort()).toEqual(
      [old.id, live.id].sort()
    );
  });

  it('refuses a name another live location of the sequence has', async () => {
    const old = await analysed('Diner');
    await analysed('Roadhouse', 'loc_002');
    const twin = await teamLocation('roadhouse');
    await expect(
      locs().replace(sequenceId, old.id, twin.id, { actorId })
    ).rejects.toThrow(/already a location in this sequence/);
    // Its own name is free to it: the link it takes over is not a twin.
    const sameName = await teamLocation('Diner');
    await expect(
      locs().replace(sequenceId, old.id, sameName.id, { actorId })
    ).resolves.toMatchObject({ id: sameName.id, locationId: 'loc_001' });
  });

  it('removes a stale removed link to the location it moves to', async () => {
    const old = await analysed('Diner');
    const next = await analysed('Roadhouse', 'loc_002');
    await locs().softDelete(sequenceId, next.id, { actorId });

    const replaced = await locs().replace(sequenceId, old.id, next.id, {
      actorId,
    });

    expect(replaced).toMatchObject({
      id: next.id,
      linkId: old.linkId,
      locationId: 'loc_001',
      deletedAt: null,
    });
    expect(await linksOf()).toMatchObject([
      { id: old.linkId, locationId: next.id, scriptLocationId: 'loc_001' },
    ]);
  });

  it('refuses a location that is not linked here, or deleted from the team', async () => {
    const unlinked = await teamLocation('Depot');
    const next = await teamLocation('Roadhouse');
    await expect(
      locs().replace(sequenceId, unlinked.id, next.id, { actorId })
    ).rejects.toThrow('Location not found');

    const old = await analysed('Diner');
    await locs().softDeleteForTeam(next.id);
    await expect(
      locs().replace(sequenceId, old.id, next.id, { actorId })
    ).rejects.toThrow('Location not found');
    expect(await linksOf()).toMatchObject([{ locationId: old.id }]);
  });
});

describe('delete from the team', () => {
  it('is refused while a sequence uses the location', async () => {
    const diner = await analysed('Diner');
    expect(await locs().getUsedInAnySequenceOrArchive(diner.id)).toBe(true);
    expect(await locs().softDeleteForTeam(diner.id)).toBe(false);
    expect((await rowOf(diner.id)).deletedAt).toBeNull();
  });

  it('is refused while an archived sequence uses it', async () => {
    const diner = await analysed('Diner');
    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, sequenceId));

    expect(await locs().getUsedInAnySequenceOrArchive(diner.id)).toBe(true);
    expect(await locs().softDeleteForTeam(diner.id)).toBe(false);
    expect(await locs().getCurrent(diner.id)).not.toBeNull();
  });

  it('succeeds once no sequence uses it, hides it, and undoes', async () => {
    const diner = await analysed('Diner');
    await locs().softDelete(sequenceId, diner.id, { actorId });
    expect(await locs().getUsedInAnySequenceOrArchive(diner.id)).toBe(false);

    expect(await locs().softDeleteForTeam(diner.id)).toBe(true);
    expect(await locs().getCurrent(diner.id)).toBeNull();
    expect(await locs().getCurrentByIds([diner.id])).toEqual([]);
    expect(await locs().getTeamLocation(diner.id)).toBeNull();
    expect(await locs().listTeam()).toEqual([]);
    await expect(
      locs().updateBible(null, diner.id, { name: 'Cafe' }, { actorId })
    ).rejects.toThrow('Location not found');
    // Every row of it stays.
    expect(await locs().listBibleVersions(diner.id)).toHaveLength(1);
    // A second delete has nothing to do.
    expect(await locs().softDeleteForTeam(diner.id)).toBe(false);

    await locs().restoreForTeam(diner.id);
    expect((await locs().getCurrent(diner.id))?.name).toBe('Diner');
  });

  it('succeeds for a location no sequence ever used', async () => {
    const depot = await teamLocation('Depot');
    expect(await locs().softDeleteForTeam(depot.id)).toBe(true);
  });
});

describe('restore through a sequence', () => {
  it('brings the link back and clears a team delete too', async () => {
    const diner = await analysed('Diner');
    await locs().softDelete(sequenceId, diner.id, { actorId });
    expect(await locs().softDeleteForTeam(diner.id)).toBe(true);

    const restored = await locs().restore(sequenceId, diner.id, { actorId });

    expect(restored.deletedAt).toBeNull();
    expect((await rowOf(diner.id)).deletedAt).toBeNull();
    expect((await locs().getCurrent(diner.id))?.id).toBe(diner.id);
    expect(await locs().list(sequenceId)).toHaveLength(1);
    expect(await eventKinds()).toEqual([
      'location.deleted',
      'location.restored',
    ]);
  });

  it('is refused while a live location of the sequence has its name', async () => {
    const diner = await analysed('Diner');
    await locs().softDelete(sequenceId, diner.id, { actorId });
    await analysed('Diner', 'loc_002');
    await expect(
      locs().restore(sequenceId, diner.id, { actorId })
    ).rejects.toThrow(/already a location in this sequence/);
    expect(
      (await locs().getById(sequenceId, diner.id))?.deletedAt
    ).toBeInstanceOf(Date);
  });
});

describe('reference photos', () => {
  const claimOf = async (id: string) =>
    (await rowOf(id)).pendingPromoteReferenceVersionId;

  it('adding photos revokes a pending sheet claim and lists them oldest first', async () => {
    const depot = await teamLocation('Depot');
    const claim = await locs().claimReference(depot.id, {
      markGenerating: true,
    });
    expect(await claimOf(depot.id)).toBe(claim);

    await locs().addPhotos(depot.id, [
      { url: '/r2/a.png', path: 'a.png' },
      { url: '/r2/b.png', path: 'b.png' },
    ]);

    expect(await claimOf(depot.id)).toBeNull();
    const photos = await locs().listPhotos(depot.id);
    expect(photos.map((photo) => photo.path).sort()).toEqual([
      'a.png',
      'b.png',
    ]);
    expect(photos.every((photo) => photo.locationId === depot.id)).toBe(true);
  });

  it('adding no photos changes nothing', async () => {
    const depot = await teamLocation('Depot');
    const claim = await locs().claimReference(depot.id, {
      markGenerating: true,
    });
    await locs().addPhotos(depot.id, []);
    expect(await claimOf(depot.id)).toBe(claim);
  });

  it('removing a photo revokes a pending sheet claim', async () => {
    const depot = await teamLocation('Depot');
    await locs().addPhotos(depot.id, [{ url: '/r2/a.png', path: 'a.png' }]);
    const [photo] = await locs().listPhotos(depot.id);
    if (!photo) throw new Error('test setup: no photo');
    const claim = await locs().claimReference(depot.id, {
      markGenerating: true,
    });
    expect(await claimOf(depot.id)).toBe(claim);

    await locs().removePhoto(depot.id, photo.id);

    expect(await claimOf(depot.id)).toBeNull();
    expect(await locs().listPhotos(depot.id)).toEqual([]);
  });

  it("does not remove another location's photo", async () => {
    const depot = await teamLocation('Depot');
    const yard = await teamLocation('Yard');
    await locs().addPhotos(yard.id, [{ url: '/r2/y.png', path: 'y.png' }]);
    const [photo] = await locs().listPhotos(yard.id);
    if (!photo) throw new Error('test setup: no photo');

    await expect(locs().removePhoto(depot.id, photo.id)).rejects.toThrow(
      'Photo not found'
    );
    expect(await locs().listPhotos(yard.id)).toHaveLength(1);
  });

  it('is refused on a location deleted from the team', async () => {
    const depot = await teamLocation('Depot');
    await locs().softDeleteForTeam(depot.id);
    await expect(
      locs().addPhotos(depot.id, [{ url: '/r2/a.png', path: 'a.png' }])
    ).rejects.toThrow('Location not found');
    expect(await db.select().from(locationReferencePhotos)).toEqual([]);
  });
});

describe('rendering is required', () => {
  it('on a location made in a sequence', async () => {
    for (const rendering of ['', '   ']) {
      await expect(
        locs().create(
          { sequenceId, locationId: 'loc_001', name: 'Diner', rendering },
          analysis
        )
      ).rejects.toThrow(/Rendering is required/);
    }
    expect(await db.select().from(locations)).toEqual([]);
    expect(await db.select().from(sequenceLocationLinks)).toEqual([]);
  });

  it('on a location made from no sequence', async () => {
    await expect(
      locs().createForTeam(
        { name: 'Depot', rendering: ' ' },
        { createdBy: actorId }
      )
    ).rejects.toThrow(/Rendering is required/);
    expect(await db.select().from(locations)).toEqual([]);
  });

  it('on a bible edit, through a sequence and from none', async () => {
    const diner = await analysed('Diner');
    await expect(
      locs().updateBible(sequenceId, diner.id, { rendering: '' }, { actorId })
    ).rejects.toThrow(/Rendering is required/);
    await expect(
      locs().updateBible(null, diner.id, { rendering: '  ' }, { actorId })
    ).rejects.toThrow(/Rendering is required/);

    expect((await locs().getCurrent(diner.id))?.rendering).toBe(
      PHOTOREAL_RENDERING
    );
    expect(await locs().listBibleVersions(diner.id)).toHaveLength(1);
    expect(await eventKinds()).toEqual([]);
  });

  it('is stored trimmed', async () => {
    const depot = await locs().createForTeam(
      { name: 'Depot', rendering: '  2D cel animation ' },
      { createdBy: actorId }
    );
    expect(depot.rendering).toBe('2D cel animation');
  });
});

describe('a bible edit and the sheet claim', () => {
  const claimed = async () => {
    const diner = await analysed('Diner');
    const claim = await locs().claimReference(diner.id, {
      markGenerating: true,
    });
    return { diner, claim };
  };
  const claimOf = async (id: string) =>
    (await rowOf(id)).pendingPromoteReferenceVersionId;

  it.each([
    ['name', 'Cafe'],
    ['type', 'interior'],
    ['description', 'chrome and neon'],
    ['architecturalStyle', 'googie'],
    ['keyFeatures', 'a long counter'],
    ['ambiance', 'sleepy'],
    ['rendering', '3D animated, Pixar-like'],
  ] as const)('revokes the claim when %s moves', async (field, value) => {
    const { diner } = await claimed();
    const edited = await locs().updateBible(
      sequenceId,
      diner.id,
      { [field]: value },
      { actorId }
    );
    expect(edited[field]).toBe(value);
    expect(await claimOf(diner.id)).toBeNull();
  });

  it('keeps the claim when only the consistency tag moves', async () => {
    const { diner, claim } = await claimed();
    const edited = await locs().updateBible(
      sequenceId,
      diner.id,
      { consistencyTag: 'diner_chrome' },
      { actorId }
    );
    expect(edited.selectedBibleVersionId).not.toBe(
      diner.selectedBibleVersionId
    );
    expect(await claimOf(diner.id)).toBe(claim);
  });

  it('keeps the claim and appends nothing when nothing moved', async () => {
    const { diner, claim } = await claimed();
    await locs().updateBible(
      sequenceId,
      diner.id,
      { name: 'Diner', rendering: PHOTOREAL_RENDERING },
      { actorId }
    );
    expect(await claimOf(diner.id)).toBe(claim);
    expect(await locs().listBibleVersions(diner.id)).toHaveLength(1);
  });

  it('from no sequence is the same write with no event', async () => {
    const { diner } = await claimed();
    const edited = await locs().updateBible(
      null,
      diner.id,
      { description: 'chrome and neon' },
      { actorId }
    );
    expect(edited.description).toBe('chrome and neon');
    expect(await claimOf(diner.id)).toBeNull();
    expect(await eventKinds()).toEqual([]);
    // Every sequence that uses it reads the new version.
    expect((await locs().getById(sequenceId, diner.id))?.description).toBe(
      'chrome and neon'
    );
  });

  it('a conditional claim is taken only while the snapshotted bible is live', async () => {
    const diner = await analysed('Diner');
    const snapshot = { bibleVersionId: diner.selectedBibleVersionId ?? '' };
    expect(
      (await locs().claimReferenceIfUnmoved(diner.id, snapshot)).held
    ).toBe(true);

    await locs().updateBible(
      sequenceId,
      diner.id,
      { description: 'moved' },
      { actorId }
    );
    expect(
      (await locs().claimReferenceIfUnmoved(diner.id, snapshot)).held
    ).toBe(false);
    expect(await claimOf(diner.id)).toBeNull();
  });

  it('a failed run clears only the claim it holds', async () => {
    const diner = await analysed('Diner');
    const older = await locs().claimReference(diner.id, {
      markGenerating: true,
    });
    const newer = await locs().claimReference(diner.id, {
      markGenerating: true,
    });

    await locs().failReferenceClaim(diner.id, older, 'boom');
    expect(await rowOf(diner.id)).toMatchObject({
      pendingPromoteReferenceVersionId: newer,
      referenceStatus: 'generating',
    });

    await locs().failReferenceClaim(diner.id, newer, 'boom');
    expect(await rowOf(diner.id)).toMatchObject({
      pendingPromoteReferenceVersionId: null,
      referenceStatus: 'failed',
      referenceError: 'boom',
    });
  });
});

describe('the team list', () => {
  const stamp = (id: string, updatedAt: string) =>
    db
      .update(sequences)
      .set({ updatedAt: new Date(updatedAt) })
      .where(eq(sequences.id, id));

  it('lists the most recently changed sequence first and the unused last', async () => {
    await stamp(sequenceId, '2026-01-01T00:00:00Z');
    await stamp(secondSequenceId, '2026-02-01T00:00:00Z');
    // Used by the older sequence only.
    const older = await analysed('Older', 'loc_001', sequenceId);
    // Used by the newer sequence only.
    const newer = await analysed('Newer', 'loc_001', secondSequenceId);
    // Used by both: as recent as `newer`, and in more sequences.
    const both = await analysed('Both', 'loc_002', sequenceId);
    await locs().attach(secondSequenceId, both.id, { actorId });
    // Used by nothing.
    const unused = await teamLocation('Unused');
    // Its only link is removed.
    const removed = await analysed('Removed', 'loc_003', sequenceId);
    await locs().softDelete(sequenceId, removed.id, { actorId });
    // Deleted from the team, and another team's.
    const deleted = await teamLocation('Deleted');
    await locs().softDeleteForTeam(deleted.id);
    await theirs().createForTeam(
      { name: 'Theirs', rendering: PHOTOREAL_RENDERING },
      { createdBy: actorId }
    );

    const list = await locs().listTeam();

    expect(list.map((location) => location.name)).toEqual([
      'Both',
      'Newer',
      'Older',
      'Removed',
      'Unused',
    ]);
    const byId = new Map(list.map((location) => [location.id, location]));
    expect(byId.get(both.id)).toMatchObject({
      usedAnywhere: true,
      lastUsedAt: new Date('2026-02-01T00:00:00Z'),
      sequences: [
        { id: secondSequenceId, title: 'Two' },
        { id: sequenceId, title: 'One' },
      ],
    });
    expect(byId.get(newer.id)?.sequences).toEqual([
      { id: secondSequenceId, title: 'Two' },
    ]);
    expect(byId.get(older.id)).toMatchObject({
      usedAnywhere: true,
      lastUsedAt: new Date('2026-01-01T00:00:00Z'),
    });
    for (const id of [unused.id, removed.id]) {
      expect(byId.get(id)).toMatchObject({
        usedAnywhere: false,
        lastUsedAt: null,
        sequences: [],
      });
    }
    expect(await locs().getTeamLocation(both.id)).toEqual(byId.get(both.id));
  });

  it('an archived sequence still holds the location but is not listed as a use', async () => {
    const diner = await analysed('Diner');
    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, sequenceId));

    expect(await locs().listTeam()).toMatchObject([
      { id: diner.id, usedAnywhere: true, lastUsedAt: null, sequences: [] },
    ]);
  });

  it('shows the selected sheet', async () => {
    const diner = await analysed('Diner');
    const versionId = generateId();
    await db.insert(locationSheetVariants).values({
      id: versionId,
      locationId: diner.id,
      model: 'm',
      url: '/r2/diner.png',
      storagePath: 'diner.png',
      portraitUrl: '/r2/diner-portrait.png',
      status: 'completed',
    });
    await db
      .update(locations)
      .set({ selectedReferenceVersionId: versionId })
      .where(eq(locations.id, diner.id));

    expect(await locs().listTeam()).toMatchObject([
      {
        referenceImageUrl: '/r2/diner.png',
        referencePortraitUrl: '/r2/diner-portrait.png',
      },
    ]);
  });
});

describe('deleting a sequence', () => {
  it('removes its links, and only the locations it alone made', async () => {
    const own = await analysed('Own', 'loc_001');
    const attached = await teamLocation('Attached');
    await locs().attach(sequenceId, attached.id, { actorId });
    const shared = await analysed('Shared', 'loc_002');
    await locs().attach(secondSequenceId, shared.id, { actorId });
    await locs().addPhotos(own.id, [{ url: '/r2/a.png', path: 'a.png' }]);

    await createSequencesMethods(db, teamId, actorId).delete(sequenceId, {
      releasedVoiceIds: [],
    });

    expect(await linksOf()).toEqual([]);
    expect(
      (await db.select().from(locations)).map((row) => row.id).sort()
    ).toEqual([attached.id, shared.id].sort());
    expect(await locs().listBibleVersions(own.id)).toEqual([]);
    expect(await db.select().from(locationReferencePhotos)).toEqual([]);
    expect(await linksOf(secondSequenceId)).toMatchObject([
      { locationId: shared.id },
    ]);
  });
});

// The matcher that binds a scene to its location reads these linked rows.
const linked = (
  overrides: Pick<
    SequenceLocationWithReference,
    'id' | 'locationId' | 'name' | 'consistencyTag'
  >
): SequenceLocationWithReference => ({
  linkId: `link-${overrides.id}`,
  sequenceId: 'seq-1',
  teamId: 'team-1',
  type: null,
  description: null,
  architecturalStyle: null,
  keyFeatures: null,
  ambiance: null,
  rendering: PHOTOREAL_RENDERING,
  firstMentionSceneId: null,
  firstMentionText: null,
  firstMentionLine: null,
  attached: false,
  referenceImageUrl: null,
  referenceImagePath: null,
  referencePortraitUrl: null,
  referenceStatus: 'pending',
  referenceGeneratedAt: null,
  referenceError: null,
  referenceInputHash: null,
  legacyLibraryReferenceHash: null,
  selectedReferenceVersionId: null,
  selectedBibleVersionId: null,
  pendingPromoteReferenceVersionId: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockLocations = [
  linked({
    id: 'loc-1',
    locationId: 'loc_001',
    name: 'INT. OFFICE - DAY',
    consistencyTag: 'office_modern_glass',
  }),
  linked({
    id: 'loc-2',
    locationId: 'loc_002',
    name: 'EXT. STREET - NIGHT',
    consistencyTag: 'city_street_night',
  }),
  linked({
    id: 'loc-3',
    locationId: 'loc_003',
    name: 'INT. APARTMENT - EVENING',
    consistencyTag: 'apartment_cozy',
  }),
];

describe('matchLocationsToScene', () => {
  it('matches on the scene environment tag', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      'office_modern_glass',
      ''
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('matches on the scene location when there is no environment tag', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      '',
      'INT. OFFICE - DAY'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('matches a street location by tag', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      'city_street_night',
      ''
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-2']);
  });

  it('returns nothing when neither key is set', () => {
    expect(matchLocationsToScene(mockLocations, '', '')).toEqual([]);
  });
});

describe('matchLocationsToScene — prose scripts (no slugline)', () => {
  it('finds the set named in the scene text when tag and slugline are empty', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      '',
      '',
      'Mateo pushes through the office doors at a run.'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('prefers the location whose whole name the text carries', () => {
    // "city street" is both tokens of loc-2's consistency tag; "office" is one
    // of loc-1's. The more specific match wins.
    const matched = matchLocationsToScene(
      mockLocations,
      '',
      '',
      'They meet on the city street outside the office block.'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-2']);
  });

  it('does not scan the text when the tag already matched', () => {
    const matched = matchLocationsToScene(
      mockLocations,
      'office_modern_glass',
      '',
      'A wide shot of the city street.'
    );
    expect(matched.map((l) => l.id)).toEqual(['loc-1']);
  });

  it('returns nothing when the text names no location', () => {
    expect(
      matchLocationsToScene(mockLocations, '', '', 'Close on her hands.')
    ).toEqual([]);
  });
});
