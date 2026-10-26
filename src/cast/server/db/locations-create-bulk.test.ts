/**
 * `locations.createBulk`: one analysis pass over a sequence's locations
 * (#846 RC4, #1695). In-memory libSQL with the real migrations.
 *
 * LocationBibleWorkflow's `create-location-records` step replays after a
 * partial commit, so the write upserts on the sequence's script ids: a
 * replay converges, keeps each location's id and leaves the reference to
 * the sheet run that owns it.
 *
 * A location is the team's (#1695), so analysis rewrites only one this
 * sequence made and nothing else uses. One the writer attached, or that
 * another sequence links, is linked and left as it is. An entry matching
 * bound to a team location (`boundTo`) links to it and makes nothing.
 */
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  locationBibleVersions,
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
import { createLocationsMethods } from './locations';
import type { AnalysedLocation } from './locations';

let closeDb: () => Promise<void>;
let db: Database;
let teamId = '';
let otherTeamId = '';
let actorId = '';
let sequenceId = '';
let secondSequenceId = '';

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
  await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });
  await db.insert(teams).values([
    { id: teamId, name: 'T', slug: 't' },
    { id: otherTeamId, name: 'O', slug: 'o' },
  ]);
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
  await db.insert(sequences).values([
    { id: sequenceId, teamId, title: 'One', styleId: style.id },
    { id: secondSequenceId, teamId, title: 'Two', styleId: style.id },
  ]);
});

const locs = () => createLocationsMethods(db, teamId);

/** One entry of an analysis pass over `sequenceId`. */
function entry(
  scriptId: string,
  overrides: Partial<AnalysedLocation> = {}
): AnalysedLocation {
  return {
    id: generateId(),
    sequenceId,
    locationId: scriptId,
    name: `Location ${scriptId}`,
    description: `Description for ${scriptId}`,
    rendering: PHOTOREAL_RENDERING,
    referenceStatus: 'generating',
    boundTo: null,
    ...overrides,
  };
}

const bulk = (entries: AnalysedLocation[]) =>
  locs().createBulk(entries, analysis);

const linksOf = (seq = sequenceId) =>
  db
    .select()
    .from(sequenceLocationLinks)
    .where(eq(sequenceLocationLinks.sequenceId, seq));

const versionsOf = (id: string) =>
  db
    .select()
    .from(locationBibleVersions)
    .where(eq(locationBibleVersions.locationId, id));

/** A location made on the Locations page: no link. */
const teamLocation = (name: string, description = 'as the team wrote it') =>
  locs().createForTeam(
    {
      name,
      description,
      rendering: '2D cel animation',
      consistencyTag: 'team_tag',
    },
    { createdBy: actorId }
  );

describe('createBulk', () => {
  it('a full replay converges instead of throwing UNIQUE violations', async () => {
    const scriptIds = ['loc_001', 'loc_002', 'loc_003', 'loc_004'];
    const first = await bulk(scriptIds.map((id) => entry(id)));
    expect(first).toHaveLength(4);

    // Workflow-step retry replays the whole closure with fresh ULIDs but the
    // same (sequenceId, locationId) pairs.
    const replay = await bulk(scriptIds.map((id) => entry(id)));

    // Same row count (the workflow's `created.length` guard keeps working)
    // and the original ids survive — the replay updates, it doesn't insert.
    expect(replay).toHaveLength(4);
    expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(await linksOf()).toHaveLength(4);
    expect(await db.select().from(locations)).toHaveLength(4);
    // Nothing moved, so no version was appended.
    expect(await db.select().from(locationBibleVersions)).toHaveLength(4);
  });

  it('makes each location the team’s, linked and not attached', async () => {
    const [created] = await bulk([
      entry('loc_001', {
        firstMentionSceneId: 'scene_001',
        firstMentionText: 'INT. DINER',
        firstMentionLine: 2,
      }),
    ]);
    expect(created).toMatchObject({
      teamId,
      sequenceId,
      locationId: 'loc_001',
      attached: false,
      deletedAt: null,
      rendering: PHOTOREAL_RENDERING,
      referenceStatus: 'generating',
      held: false,
      firstMentionSceneId: 'scene_001',
      firstMentionText: 'INT. DINER',
      firstMentionLine: 2,
    });
  });

  it('refreshes bible fields but leaves reference-image columns untouched', async () => {
    const [created] = await bulk([entry('loc_001')]);
    if (!created) throw new Error('test setup: createBulk returned nothing');

    // Child LocationSheetWorkflow completes the reference in the meantime.
    // The image lands on the version row, not the parent (#1419).
    await db
      .update(locations)
      .set({ referenceStatus: 'completed' })
      .where(eq(locations.id, created.id));
    await db.insert(locationSheetVariants).values({
      id: created.id,
      locationId: created.id,
      model: 'prior',
      url: 'https://r2/loc_001.png',
      storagePath: 'locations/loc_001.png',
      status: 'completed',
    });

    const [upserted] = await bulk([
      entry('loc_001', {
        description: 'fresher description',
        firstMentionText: 'a later mention',
      }),
    ]);

    expect(upserted?.id).toBe(created.id);
    expect(upserted?.description).toBe('fresher description');
    expect(upserted?.firstMentionText).toBe('a later mention');
    // Owned by the child workflow — must not be clobbered by a parent replay.
    expect(upserted?.referenceStatus).toBe('completed');
    expect(upserted?.referenceImageUrl).toBe('https://r2/loc_001.png');
    expect(upserted?.referenceImagePath).toBe('locations/loc_001.png');
    // A rewrite is a version append by analysis.
    const versions = await versionsOf(created.id);
    expect(versions).toHaveLength(2);
    expect(
      versions.find((v) => v.id === upserted?.selectedBibleVersionId)
    ).toMatchObject({ source: 'analysis', description: 'fresher description' });
  });

  it('returns [] for an empty input', async () => {
    await expect(bulk([])).resolves.toEqual([]);
  });

  it("refuses another team's sequence", async () => {
    await expect(
      createLocationsMethods(db, otherTeamId).createBulk(
        [entry('loc_001')],
        analysis
      )
    ).rejects.toThrow('Sequence not found');
    expect(await db.select().from(locations)).toEqual([]);
  });

  it('a re-analysis that brings back a removed link brings back a deleted location too', async () => {
    const [made] = await bulk([entry('loc_001')]);
    if (!made) throw new Error('test setup: createBulk returned nothing');
    await locs().softDelete(sequenceId, made.id, { actorId });
    expect(await locs().softDeleteForTeam(made.id)).toBe(true);

    const [back] = await bulk([entry('loc_001')]);
    expect(back).toMatchObject({ id: made.id, deletedAt: null });
    expect(await locs().getCurrent(made.id)).toMatchObject({
      id: made.id,
      deletedAt: null,
    });
  });
});

describe('createBulk never rewrites a location that is not this sequence’s', () => {
  it('leaves an attached location as it is, refreshing its first mention', async () => {
    const diner = await teamLocation('Diner');
    const attached = await locs().attach(sequenceId, diner.id, { actorId });
    const claim = await locs().claimReference(diner.id, {
      markGenerating: true,
    });

    const [result] = await bulk([
      entry(attached.locationId, {
        name: 'DINER (REWRITTEN)',
        description: 'what analysis wrote',
        rendering: PHOTOREAL_RENDERING,
        firstMentionText: 'INT. DINER - NIGHT',
        firstMentionLine: 7,
      }),
    ]);

    expect(result).toMatchObject({
      id: diner.id,
      name: 'Diner',
      description: 'as the team wrote it',
      rendering: '2D cel animation',
      selectedBibleVersionId: diner.selectedBibleVersionId,
      attached: true,
      firstMentionText: 'INT. DINER - NIGHT',
      firstMentionLine: 7,
      // The sheet run in flight keeps its claim: no input moved.
      pendingPromoteReferenceVersionId: claim,
    });
    expect(await versionsOf(diner.id)).toHaveLength(1);
    expect(await db.select().from(locations)).toHaveLength(1);
  });

  it('brings back the removed link of an attached location without rewriting it', async () => {
    const diner = await teamLocation('Diner');
    const attached = await locs().attach(sequenceId, diner.id, { actorId });
    await locs().softDelete(sequenceId, diner.id, { actorId });

    const [result] = await bulk([
      entry(attached.locationId, { description: 'what analysis wrote' }),
    ]);

    expect(result).toMatchObject({
      id: diner.id,
      linkId: attached.linkId,
      deletedAt: null,
      description: 'as the team wrote it',
    });
    expect(await versionsOf(diner.id)).toHaveLength(1);
  });

  it('leaves a location another sequence links as it is', async () => {
    const [made] = await bulk([
      entry('loc_001', { description: 'first pass' }),
    ]);
    if (!made) throw new Error('test setup: createBulk returned nothing');
    expect(await locs().getAnalysisMayNotRewrite(sequenceId, made.id)).toBe(
      false
    );
    await locs().attach(secondSequenceId, made.id, { actorId });
    expect(await locs().getAnalysisMayNotRewrite(sequenceId, made.id)).toBe(
      true
    );
    await locs().softDelete(sequenceId, made.id, { actorId });

    const [result] = await bulk([
      entry('loc_001', {
        description: 'second pass',
        firstMentionText: 'a later mention',
      }),
    ]);

    expect(result).toMatchObject({
      id: made.id,
      description: 'first pass',
      selectedBibleVersionId: made.selectedBibleVersionId,
      // Its link here is brought back and its first mention refreshed.
      deletedAt: null,
      firstMentionText: 'a later mention',
      attached: false,
      // The sheet fan-out reads this: the bible was left alone.
      held: true,
    });
    expect(await versionsOf(made.id)).toHaveLength(1);
    // The other sequence reads the same, unchanged location.
    expect((await locs().getById(secondSequenceId, made.id))?.description).toBe(
      'first pass'
    );
  });

  it('still holds once the other sequence removed it or was archived', async () => {
    const [made] = await bulk([
      entry('loc_001', { description: 'first pass' }),
    ]);
    if (!made) throw new Error('test setup: createBulk returned nothing');
    await locs().attach(secondSequenceId, made.id, { actorId });
    await locs().softDelete(secondSequenceId, made.id, { actorId });
    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, secondSequenceId));

    const [result] = await bulk([
      entry('loc_001', { description: 'second pass' }),
    ]);
    expect(result?.description).toBe('first pass');
  });

  it('rewrites a location only this sequence made, reviving it when removed', async () => {
    const [made] = await bulk([
      entry('loc_001', { description: 'first pass' }),
    ]);
    if (!made) throw new Error('test setup: createBulk returned nothing');
    const claim = await locs().claimReference(made.id, {
      markGenerating: true,
    });
    await locs().softDelete(sequenceId, made.id, { actorId });

    const [result] = await bulk([
      entry('loc_001', { description: 'second pass' }),
    ]);

    expect(result).toMatchObject({
      id: made.id,
      description: 'second pass',
      deletedAt: null,
      // A sheet input moved, so the run in flight lost its claim (#1113).
      pendingPromoteReferenceVersionId: null,
      held: false,
    });
    expect(claim).not.toBeNull();
    expect(await versionsOf(made.id)).toHaveLength(2);
  });

  it('requires a rendering on a location it makes', async () => {
    await expect(bulk([entry('loc_001', { rendering: ' ' })])).rejects.toThrow(
      /Rendering is required/
    );
    expect(await db.select().from(locations)).toEqual([]);
  });
});

describe('createBulk with an entry bound to a team location', () => {
  it('links and makes nothing', async () => {
    const diner = await teamLocation('Diner');

    const [result] = await bulk([
      entry('loc_001', {
        name: 'SCRIPT DINER',
        description: 'what analysis wrote',
        consistencyTag: 'script_diner',
        firstMentionSceneId: 'scene_001',
        firstMentionText: 'INT. DINER',
        firstMentionLine: 4,
        boundTo: diner.id,
      }),
    ]);

    expect(result).toMatchObject({
      id: diner.id,
      sequenceId,
      locationId: 'loc_001',
      attached: true,
      deletedAt: null,
      // The team location's bible, not the entry's.
      name: 'Diner',
      description: 'as the team wrote it',
      rendering: '2D cel animation',
      selectedBibleVersionId: diner.selectedBibleVersionId,
      referenceStatus: 'pending',
      firstMentionSceneId: 'scene_001',
      firstMentionText: 'INT. DINER',
      firstMentionLine: 4,
      // Scenes carry the script's tag, so the link answers with it.
      consistencyTag: 'script_diner',
      held: true,
    });
    expect(await db.select().from(locations)).toHaveLength(1);
    expect(await versionsOf(diner.id)).toHaveLength(1);
    expect(await linksOf()).toHaveLength(1);
    // The location's own tag is untouched.
    expect((await locs().getCurrent(diner.id))?.consistencyTag).toBe(
      'team_tag'
    );
    // And analysis never rewrites it afterwards.
    expect(await locs().getAnalysisMayNotRewrite(sequenceId, diner.id)).toBe(
      true
    );
  });

  it('is idempotent on replay', async () => {
    const diner = await teamLocation('Diner');
    const bound = () => bulk([entry('loc_001', { boundTo: diner.id })]);
    const [first] = await bound();
    const [second] = await bound();
    expect(second).toEqual(first);
    expect(await linksOf()).toHaveLength(1);
  });

  it("a bible edit through the sequence never writes the script's tag into the team's bible", async () => {
    const diner = await teamLocation('Diner');
    await bulk([
      entry('loc_001', { consistencyTag: 'script_diner', boundTo: diner.id }),
    ]);

    const edited = await locs().updateBible(
      sequenceId,
      diner.id,
      { description: 'chrome and neon' },
      { actorId }
    );

    // The linked read still answers with the script's tag.
    expect(edited).toMatchObject({
      description: 'chrome and neon',
      consistencyTag: 'script_diner',
    });
    // The new version keeps the location's own.
    const versions = await versionsOf(diner.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.consistencyTag)).toEqual([
      'team_tag',
      'team_tag',
    ]);
    expect(await locs().getCurrent(diner.id)).toMatchObject({
      description: 'chrome and neon',
      consistencyTag: 'team_tag',
    });
  });

  it('takes the script id over from the link that held it', async () => {
    const [made] = await bulk([entry('loc_001')]);
    if (!made) throw new Error('test setup: createBulk returned nothing');
    const diner = await teamLocation('Diner');

    const [result] = await bulk([entry('loc_001', { boundTo: diner.id })]);

    expect(result).toMatchObject({
      id: diner.id,
      linkId: made.linkId,
      locationId: 'loc_001',
      attached: true,
    });
    expect(await linksOf()).toMatchObject([
      { locationId: diner.id, scriptLocationId: 'loc_001' },
    ]);
    // The place analysis made before is out of the sequence. Nothing uses
    // it, so it leaves the team list too; its rows stay.
    expect(await locs().getById(sequenceId, made.id)).toBeNull();
    expect(await locs().getCurrent(made.id)).toBeNull();
    expect(await versionsOf(made.id)).toHaveLength(1);
  });

  it('re-points a link the sequence already has to the location', async () => {
    const diner = await teamLocation('Diner');
    const attached = await locs().attach(sequenceId, diner.id, { actorId });
    expect(attached.locationId).toBe('loc_diner');

    const [result] = await bulk([entry('loc_001', { boundTo: diner.id })]);

    expect(result).toMatchObject({
      id: diner.id,
      linkId: attached.linkId,
      locationId: 'loc_001',
    });
    expect(await linksOf()).toHaveLength(1);
    expect(await locs().getByLocationId(sequenceId, 'loc_diner')).toBeNull();
  });

  it('re-points its own link and drops the one that held the script id', async () => {
    const [made] = await bulk([entry('loc_001')]);
    if (!made) throw new Error('test setup: createBulk returned nothing');
    const diner = await teamLocation('Diner');
    const attached = await locs().attach(sequenceId, diner.id, { actorId });
    expect(await linksOf()).toHaveLength(2);

    const [result] = await bulk([entry('loc_001', { boundTo: diner.id })]);

    expect(result).toMatchObject({
      id: diner.id,
      linkId: attached.linkId,
      locationId: 'loc_001',
    });
    expect(await linksOf()).toMatchObject([
      {
        id: attached.linkId,
        locationId: diner.id,
        scriptLocationId: 'loc_001',
      },
    ]);
    expect(await locs().getCurrent(made.id)).toBeNull();
  });

  it('brings back a removed link to the location', async () => {
    const diner = await teamLocation('Diner');
    await locs().attach(sequenceId, diner.id, { actorId });
    await locs().softDelete(sequenceId, diner.id, { actorId });

    const [result] = await bulk([entry('loc_001', { boundTo: diner.id })]);
    expect(result).toMatchObject({ id: diner.id, deletedAt: null });
  });

  it("refuses another team's location, and one deleted from the team", async () => {
    const theirs = await createLocationsMethods(db, otherTeamId).createForTeam(
      { name: 'Their Yard', rendering: PHOTOREAL_RENDERING },
      { createdBy: actorId }
    );
    await expect(
      bulk([entry('loc_001', { boundTo: theirs.id })])
    ).rejects.toThrow('Location not found');

    const deleted = await teamLocation('Deleted');
    await locs().softDeleteForTeam(deleted.id);
    await expect(
      bulk([entry('loc_001', { boundTo: deleted.id })])
    ).rejects.toThrow('Location not found');
    expect(await linksOf()).toEqual([]);
  });
});
