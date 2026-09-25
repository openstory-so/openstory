/**
 * Shot dialogue node (#1657): authored versions, recordings and the per-shot
 * sections that point into them, against in-memory libSQL with the real
 * migrations.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  dialogueRecordings,
  scenes,
  sequences,
  shotDialogueSections,
  shotDialogueVersions,
  shots,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import type { ShotDialogueLine } from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createShotDialogueMethods,
  type AppendDialogueRecordingInput,
} from './shot-dialogue';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';
let otherShotId = '';
let deletedShotId = '';

const line = (text: string): ShotDialogueLine => ({
  character: 'Maya',
  line: text,
  tone: 'calm',
});

type SectionInput = AppendDialogueRecordingInput['sections'][number];

const section = (
  forShotId: string,
  selected: boolean,
  overrides: Partial<SectionInput> = {}
): SectionInput => ({
  id: generateId(),
  shotId: forShotId,
  fromSeconds: 0,
  toSeconds: 2,
  sourceKey: 'k',
  spokenLines: null,
  dialogueVersionId: null,
  // The claim id is filled in by `land`, which claims first like the recorder.
  adopt: selected ? { claimId: '', audioClips: [clipOf(forShotId)] } : null,
  ...overrides,
});

const clipOf = (forShotId: string) => ({
  id: `clip-${forShotId}`,
  url: '/r2/cut.wav',
  token: 'DIALOGUE',
  durationSeconds: 2,
  sourceKey: 'k',
});

type Methods = ReturnType<typeof createShotDialogueMethods>;
const claimIdBySectionId = new Map<string, string>();

/**
 * Land a recording the way the recorder does: claim each adopting shot, then
 * write. Claim ids are remembered per section, so landing the same input
 * twice is a step REPLAY (same claims), not a second run.
 */
const land = async (methods: Methods, input: AppendDialogueRecordingInput) => {
  const sections: SectionInput[] = [];
  for (const entry of input.sections) {
    if (!entry.adopt) {
      sections.push(entry);
      continue;
    }
    let claimId = claimIdBySectionId.get(entry.id);
    if (claimId === undefined) {
      const claims = await methods.claimRecording({
        shots: [{ shotId: entry.shotId, sourceKey: entry.sourceKey }],
        workflowRunId: `run-${entry.id}`,
      });
      claimId = claims[entry.shotId] ?? 'not-claimed';
      claimIdBySectionId.set(entry.id, claimId);
    }
    sections.push({ ...entry, adopt: { ...entry.adopt, claimId } });
  }
  return await methods.appendRecording({ ...input, sections });
};

const recording = (
  sections: SectionInput[],
  overrides: Partial<AppendDialogueRecordingInput> = {}
): AppendDialogueRecordingInput => ({
  id: generateId(),
  sequenceId,
  storageKey: 'audio/t/s/dialogue/take.wav',
  url: '/r2/audio/take.wav',
  durationSeconds: 4.5,
  turns: [
    {
      shotId,
      index: 0,
      voiceId: 'voice-1',
      ttsModel: 'eleven_v3',
      startSeconds: 0,
      endSeconds: 2,
    },
  ],
  inputHash: 'hash-1',
  characterCount: 42,
  workflowRunId: 'run-1',
  adoptedAs: 'recorded',
  sections,
  ...overrides,
});

const versionsOf = async (forShotId: string) =>
  await db
    .select()
    .from(shotDialogueVersions)
    .where(eq(shotDialogueVersions.shotId, forShotId));

async function seed() {
  await db.delete(shotDialogueSections);
  await db.delete(dialogueRecordings);
  await db.delete(shotDialogueVersions);
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
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
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const inserted = await db
    .insert(shots)
    .values([
      { sequenceId, shotNumber: 1 },
      { sequenceId, shotNumber: 2 },
      { sequenceId, shotNumber: 3, deletedAt: new Date() },
    ])
    .returning();
  const [first, second, third] = inserted;
  if (!first || !second || !third) {
    throw new Error('test setup: shot insert failed');
  }
  shotId = first.id;
  otherShotId = second.id;
  deletedShotId = third.id;
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

describe('authored versions', () => {
  it('appends and moves the selection, keeping history', async () => {
    const methods = createShotDialogueMethods(db);
    const first = await methods.write(shotId, [line('A')], 'prompt');
    const second = await methods.write(shotId, [line('B')], 'user-edit');

    expect(second?.id).not.toBe(first?.id);
    expect((await methods.getSelected(shotId))?.id).toBe(second?.id);
    const versions = await versionsOf(shotId);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.selectedAt)).toHaveLength(1);
  });

  it('appends nothing and returns the selected row when the lines are identical', async () => {
    const methods = createShotDialogueMethods(db);
    const first = await methods.write(shotId, [line('A')], 'prompt');
    const again = await methods.write(shotId, [line('A')], 'user-edit');
    expect(again).toEqual(first);
    expect(await versionsOf(shotId)).toHaveLength(1);
  });

  it('appends when only a voice binding changed', async () => {
    const methods = createShotDialogueMethods(db);
    await methods.write(shotId, [line('A')], 'prompt');
    await methods.write(
      shotId,
      [{ ...line('A'), voiceToken: 'NARRATOR' }],
      'user-edit'
    );
    expect(await versionsOf(shotId)).toHaveLength(2);
  });

  it('keeps one shot’s selection out of another’s', async () => {
    const methods = createShotDialogueMethods(db);
    const mine = await methods.write(shotId, [line('A')], 'prompt');
    const theirs = await methods.write(otherShotId, [line('X')], 'prompt');
    expect((await methods.getSelected(shotId))?.id).toBe(mine?.id);
    expect((await methods.getSelected(otherShotId))?.id).toBe(theirs?.id);
  });

  it('mints no row for a shot that never spoke, and an empty one for a shot that lost its lines', async () => {
    const methods = createShotDialogueMethods(db);
    expect(await methods.write(shotId, [], 'prompt')).toBeNull();
    expect(await versionsOf(shotId)).toHaveLength(0);

    await methods.write(shotId, [line('A')], 'prompt');
    const silenced = await methods.write(shotId, [], 'prompt');
    // Without this row the old one would keep speaking.
    expect(silenced?.lines).toEqual([]);
    expect((await methods.getSelected(shotId))?.id).toBe(silenced?.id);
  });

  it('lists the selected row of every live shot of the sequence', async () => {
    const methods = createShotDialogueMethods(db);
    await methods.write(shotId, [line('A')], 'prompt');
    await methods.write(shotId, [line('B')], 'user-edit');
    await methods.write(deletedShotId, [line('Gone')], 'prompt');
    const rows = await methods.getSelectedBySequence(sequenceId);
    expect(rows.map((row) => [row.shotId, row.lines[0]?.line])).toEqual([
      [shotId, 'B'],
    ]);
  });
});

describe('recordings and sections', () => {
  it('inserts the recording and one section per shot, selecting only the adopters', async () => {
    const methods = createShotDialogueMethods(db);
    const adopted = section(shotId, true, {
      dialogueVersionId: 'version-1',
      spokenLines: [{ index: 0, text: 'Shorter' }],
    });
    const context = section(otherShotId, false, {
      fromSeconds: 2,
      toSeconds: 4,
    });
    const input = recording([adopted, context]);
    await land(methods, input);

    expect(await db.select().from(dialogueRecordings)).toHaveLength(1);
    const mine = await methods.getSectionById(adopted.id);
    expect(mine).toMatchObject({
      shotId,
      recordingId: input.id,
      source: 'recorded',
      dialogueVersionId: 'version-1',
      spokenLines: [{ index: 0, text: 'Shorter' }],
      workflowRunId: 'run-1',
    });
    expect(mine?.selectedAt).toBeInstanceOf(Date);
    expect(mine?.recording).toMatchObject({
      id: input.id,
      storageKey: input.storageKey,
      durationSeconds: 4.5,
      turns: input.turns,
    });

    const theirs = await methods.getSectionById(context.id);
    expect(theirs).toMatchObject({
      shotId: otherShotId,
      source: 'context',
      selectedAt: null,
      fromSeconds: 2,
      toSeconds: 4,
      spokenLines: null,
      dialogueVersionId: null,
    });
  });

  it('moves an adopting shot’s selection and leaves a context shot’s alone', async () => {
    const methods = createShotDialogueMethods(db);
    const mineBefore = section(shotId, true);
    const theirsBefore = section(otherShotId, true);
    await land(methods, recording([mineBefore, theirsBefore]));

    // Shot 1 re-records; shot 2 is only spoken as context.
    const mineAfter = section(shotId, true);
    const theirsContext = section(otherShotId, false);
    await land(
      methods,
      recording([mineAfter, theirsContext], { url: '/r2/audio/take-2.wav' })
    );

    const mine = await methods.listSections(shotId);
    expect(mine).toHaveLength(2);
    expect(mine.filter((row) => row.selectedAt).map((row) => row.id)).toEqual([
      mineAfter.id,
    ]);
    const theirs = await methods.listSections(otherShotId);
    expect(theirs).toHaveLength(2);
    expect(theirs.filter((row) => row.selectedAt).map((row) => row.id)).toEqual(
      [theirsBefore.id]
    );
  });

  it('is idempotent when replayed with the same ids', async () => {
    const methods = createShotDialogueMethods(db);
    const input = recording([
      section(shotId, true),
      section(otherShotId, false),
    ]);
    await land(methods, input);
    await land(methods, input);

    expect(await db.select().from(dialogueRecordings)).toHaveLength(1);
    expect(await db.select().from(shotDialogueSections)).toHaveLength(2);
    const selected = (await methods.listSections(shotId)).filter(
      (row) => row.selectedAt
    );
    expect(selected.map((row) => row.id)).toEqual([input.sections[0]?.id]);
  });

  it('does not undo a later pick when an old recording is replayed', async () => {
    const methods = createShotDialogueMethods(db);
    const first = recording([section(shotId, true)]);
    await land(methods, first);
    const second = recording([section(shotId, true)]);
    await land(methods, second);

    await land(methods, first);
    const selected = (await methods.listSections(shotId)).filter(
      (row) => row.selectedAt
    );
    expect(selected.map((row) => row.id)).toEqual([second.sections[0]?.id]);
  });

  it('lists a shot’s readings newest first with the recording url', async () => {
    const methods = createShotDialogueMethods(db);
    const older = section(shotId, true);
    const newer = section(shotId, true);
    await land(methods, recording([older], { url: '/r2/audio/a.wav' }));
    await db
      .update(shotDialogueSections)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(shotDialogueSections.id, older.id));
    await land(methods, recording([newer], { url: '/r2/audio/b.wav' }));

    expect(
      (await methods.listSections(shotId)).map((row) => [
        row.id,
        row.recordingUrl,
      ])
    ).toEqual([
      [newer.id, '/r2/audio/b.wav'],
      [older.id, '/r2/audio/a.wav'],
    ]);
  });

  it('promotes a context reading with the same selection', async () => {
    const methods = createShotDialogueMethods(db);
    const own = section(otherShotId, true);
    await land(methods, recording([own]));
    const context = section(otherShotId, false);
    await land(methods, recording([section(shotId, true), context]));

    const clip = {
      id: context.id,
      url: '/r2/audio/cut.wav',
      token: 'DIALOGUE',
      durationSeconds: 2,
      sourceKey: 'k',
      recordingId: 'rec',
    };
    const picked = await methods.selectSection(otherShotId, context.id, [clip]);
    expect(picked.id).toBe(context.id);
    // Pointer and clip move in one batch.
    const [shotRow] = await db
      .select({ audioClips: shots.audioClips })
      .from(shots)
      .where(eq(shots.id, otherShotId));
    expect(shotRow?.audioClips).toEqual([clip]);
    const selected = (await methods.listSections(otherShotId)).filter(
      (row) => row.selectedAt
    );
    expect(selected.map((row) => row.id)).toEqual([context.id]);
    // The other shot's selection is its own.
    expect(
      (await methods.listSections(shotId)).filter((row) => row.selectedAt)
    ).toHaveLength(1);
  });

  it("omits and refuses a discarded section; discarding the current one clears the shot's clip", async () => {
    const methods = createShotDialogueMethods(db);
    const mine = section(shotId, true);
    await land(methods, recording([mine]));
    await db
      .update(shots)
      .set({
        audioClips: [
          {
            id: mine.id,
            url: '/r2/cut.wav',
            token: 'DIALOGUE',
            durationSeconds: 2,
            sourceKey: mine.sourceKey,
          },
        ],
      })
      .where(eq(shots.id, shotId));

    await methods.discardSection(shotId, mine.id);

    expect(await methods.listSections(shotId)).toEqual([]);
    const stored = await methods.getSectionById(mine.id);
    expect(stored?.selectedAt).toBeNull();
    expect(stored?.discardedAt).toBeInstanceOf(Date);
    // The shot must not keep audio cut from a reading that is gone.
    const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
    expect(shot?.audioClips).toEqual([]);
    await expect(methods.selectSection(shotId, mine.id, [])).rejects.toThrow(
      /discarded/
    );
  });

  it('discarding a reading the shot does not use leaves its clip alone', async () => {
    const methods = createShotDialogueMethods(db);
    const current = section(shotId, true);
    await land(methods, recording([current]));
    const spare = section(shotId, false);
    await land(methods, recording([spare]));
    const clip = {
      id: current.id,
      url: '/r2/cut.wav',
      token: 'DIALOGUE',
      durationSeconds: 2,
      sourceKey: current.sourceKey,
    };
    await db
      .update(shots)
      .set({ audioClips: [clip] })
      .where(eq(shots.id, shotId));

    await methods.discardSection(shotId, spare.id);

    const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
    expect(shot?.audioClips).toEqual([clip]);
    expect(
      (await methods.getSectionById(current.id))?.selectedAt
    ).not.toBeNull();
  });

  it('restores an earlier version without deleting the newer one', async () => {
    const methods = createShotDialogueMethods(db);
    const first = await methods.write(shotId, [line('A')], 'prompt');
    await methods.write(shotId, [line('B')], 'user-edit');
    if (!first) throw new Error('expected a first version');

    await methods.selectVersion(shotId, first.id);

    expect((await methods.getSelected(shotId))?.id).toBe(first.id);
    const versions = await methods.listVersions(shotId);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.selectedAt)).toHaveLength(1);
  });

  it('refuses a version id from another shot', async () => {
    const methods = createShotDialogueMethods(db);
    const other = await methods.write(otherShotId, [line('X')], 'prompt');
    if (!other) throw new Error('expected a version');
    await expect(methods.selectVersion(shotId, other.id)).rejects.toThrow(
      /not found/
    );
  });

  it('refuses a range that is empty, negative or past the recording', async () => {
    const methods = createShotDialogueMethods(db);
    for (const range of [
      { fromSeconds: 2, toSeconds: 2 },
      { fromSeconds: -1, toSeconds: 2 },
      { fromSeconds: 0, toSeconds: 9 },
    ]) {
      await expect(
        land(methods, recording([section(shotId, true, range)]))
      ).rejects.toThrow();
    }
    expect(await methods.listSections(shotId)).toEqual([]);
  });

  it('refuses a section of another shot', async () => {
    const methods = createShotDialogueMethods(db);
    const theirs = section(otherShotId, true);
    await land(methods, recording([theirs]));

    await expect(methods.selectSection(shotId, theirs.id, [])).rejects.toThrow(
      /not found/
    );
    await expect(methods.discardSection(shotId, theirs.id)).rejects.toThrow(
      /not found/
    );
    expect((await methods.getSectionById(theirs.id))?.discardedAt).toBeNull();
  });

  describe('claims (#1657)', () => {
    const shotRow = async () =>
      (await db.select().from(shots).where(eq(shots.id, shotId)))[0];

    it("promotes a live claim: the pointer AND the shot's clip, together", async () => {
      const methods = createShotDialogueMethods(db);
      const mine = section(shotId, true);
      const landed = await land(methods, recording([mine]));

      expect(landed.promotedShotIds).toEqual([shotId]);
      expect(
        (await methods.getSectionById(mine.id))?.selectedAt
      ).not.toBeNull();
      expect((await shotRow())?.audioClips).toEqual([clipOf(shotId)]);
      // Completed: no longer in flight.
      expect(await methods.listLiveClaims(shotId)).toEqual([]);
    });

    it('a second run for the same shot and the same words stands down', async () => {
      const methods = createShotDialogueMethods(db);
      const request = { shots: [{ shotId, sourceKey: 'k' }] };
      const first = await methods.claimRecording({
        ...request,
        workflowRunId: 'run-a',
      });
      const second = await methods.claimRecording({
        ...request,
        workflowRunId: 'run-b',
      });
      expect(Object.keys(first)).toEqual([shotId]);
      expect(second).toEqual({});
      // A replay of the first run's own claim step gets its claim back.
      expect(
        await methods.claimRecording({ ...request, workflowRunId: 'run-a' })
      ).toEqual(first);
      // Different words are a different recording: both may run.
      expect(
        Object.keys(
          await methods.claimRecording({
            shots: [{ shotId, sourceKey: 'other-words' }],
            workflowRunId: 'run-b',
          })
        )
      ).toEqual([shotId]);
    });

    it('a reading picked by hand meanwhile wins: the late one lands unselected', async () => {
      const methods = createShotDialogueMethods(db);
      const picked = section(shotId, true);
      await land(methods, recording([picked]));
      const pickedClip = { ...clipOf(shotId), id: 'picked' };

      // A new recording starts…
      const late = section(shotId, true, { sourceKey: 'k2' });
      const claims = await methods.claimRecording({
        shots: [{ shotId, sourceKey: 'k2' }],
        workflowRunId: 'run-late',
      });
      claimIdBySectionId.set(late.id, claims[shotId] ?? '');
      // …and the user picks a reading before it lands.
      await methods.selectSection(shotId, picked.id, [pickedClip]);

      const landed = await land(methods, recording([late]));

      expect(landed.promotedShotIds).toEqual([]);
      expect(
        (await methods.getSectionById(picked.id))?.selectedAt
      ).not.toBeNull();
      // Kept as a reading the user can still choose — never thrown away.
      const kept = await methods.getSectionById(late.id);
      expect(kept?.selectedAt).toBeNull();
      expect(kept?.source).toBe('recorded');
      expect((await shotRow())?.audioClips).toEqual([pickedClip]);
    });

    it('changing the lines demotes a recording of the old ones', async () => {
      const methods = createShotDialogueMethods(db);
      await methods.write(shotId, [line('Old words.')], 'prompt');
      const late = section(shotId, true);
      const claims = await methods.claimRecording({
        shots: [{ shotId, sourceKey: 'k' }],
        workflowRunId: 'run-old-words',
      });
      claimIdBySectionId.set(late.id, claims[shotId] ?? '');

      await methods.write(shotId, [line('New words.')], 'user-edit');

      expect((await land(methods, recording([late]))).promotedShotIds).toEqual(
        []
      );
      expect((await shotRow())?.audioClips ?? []).toEqual([]);
    });

    it("a cancelled claim records but never becomes the shot's audio", async () => {
      const methods = createShotDialogueMethods(db);
      const late = section(shotId, true);
      const claims = await methods.claimRecording({
        shots: [{ shotId, sourceKey: 'k' }],
        workflowRunId: 'run-cancelled',
      });
      const claimId = claims[shotId] ?? '';
      claimIdBySectionId.set(late.id, claimId);

      expect(await methods.cancelClaim(shotId, claimId)).toBe(true);
      // Another shot cannot cancel it, and it cannot be cancelled twice.
      expect(await methods.cancelClaim(otherShotId, claimId)).toBe(false);
      expect(await methods.cancelClaim(shotId, claimId)).toBe(false);

      expect((await land(methods, recording([late]))).promotedShotIds).toEqual(
        []
      );
      expect((await methods.getSectionById(late.id))?.selectedAt).toBeNull();
    });

    it('a replayed persist step agrees with the first pass', async () => {
      const methods = createShotDialogueMethods(db);
      const input = recording([section(shotId, true)]);
      const first = await land(methods, input);
      expect(await land(methods, input)).toEqual(first);
    });

    it('a failed recording clears its claims so the words can be recorded again', async () => {
      const methods = createShotDialogueMethods(db);
      const request = { shots: [{ shotId, sourceKey: 'k' }] };
      const claims = await methods.claimRecording({
        ...request,
        workflowRunId: 'run-dies',
      });
      await methods.failClaims(Object.values(claims), 'ElevenLabs 502');
      expect(await methods.listLiveClaims(shotId)).toEqual([]);
      expect(
        Object.keys(
          await methods.claimRecording({
            ...request,
            workflowRunId: 'run-next',
          })
        )
      ).toEqual([shotId]);
    });
  });

  it('returns null for a section that does not exist', async () => {
    const methods = createShotDialogueMethods(db);
    expect(await methods.getSectionById('missing')).toBeNull();
  });
});
