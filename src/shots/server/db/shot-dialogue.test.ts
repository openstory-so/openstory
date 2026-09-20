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
  selected,
  ...overrides,
});

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
  sections,
  ...overrides,
});

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

    expect(second.id).not.toBe(first.id);
    expect((await methods.getSelected(shotId))?.id).toBe(second.id);
    const versions = await methods.listVersions(shotId);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.selectedAt)).toHaveLength(1);
  });

  it('appends nothing and returns the selected row when the lines are identical', async () => {
    const methods = createShotDialogueMethods(db);
    const first = await methods.write(shotId, [line('A')], 'prompt');
    const again = await methods.write(shotId, [line('A')], 'user-edit');
    expect(again).toEqual(first);
    expect(await methods.listVersions(shotId)).toHaveLength(1);
  });

  it('appends when only a voice binding changed', async () => {
    const methods = createShotDialogueMethods(db);
    await methods.write(shotId, [line('A')], 'prompt');
    await methods.write(
      shotId,
      [{ ...line('A'), voiceToken: 'NARRATOR' }],
      'user-edit'
    );
    expect(await methods.listVersions(shotId)).toHaveLength(2);
  });

  it('keeps one shot’s selection out of another’s', async () => {
    const methods = createShotDialogueMethods(db);
    const mine = await methods.write(shotId, [line('A')], 'prompt');
    const theirs = await methods.write(otherShotId, [line('X')], 'prompt');
    expect((await methods.getSelected(shotId))?.id).toBe(mine.id);
    expect((await methods.getSelected(otherShotId))?.id).toBe(theirs.id);
  });

  it('restores an earlier version without deleting the newer one', async () => {
    const methods = createShotDialogueMethods(db);
    const first = await methods.write(shotId, [line('A')], 'prompt');
    await methods.write(shotId, [line('B')], 'user-edit');

    await methods.selectVersion(shotId, first.id);
    expect((await methods.getSelected(shotId))?.id).toBe(first.id);
    const versions = await methods.listVersions(shotId);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.selectedAt)).toHaveLength(1);
  });

  it('refuses a version id from another shot', async () => {
    const methods = createShotDialogueMethods(db);
    const other = await methods.write(otherShotId, [line('X')], 'prompt');
    await expect(methods.selectVersion(shotId, other.id)).rejects.toThrow(
      /not found/
    );
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
    await methods.appendRecording(input);

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
    await methods.appendRecording(recording([mineBefore, theirsBefore]));

    // Shot 1 re-records; shot 2 is only spoken as context.
    const mineAfter = section(shotId, true);
    const theirsContext = section(otherShotId, false);
    await methods.appendRecording(
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
    await methods.appendRecording(input);
    await methods.appendRecording(input);

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
    await methods.appendRecording(first);
    const second = recording([section(shotId, true)]);
    await methods.appendRecording(second);

    await methods.appendRecording(first);
    const selected = (await methods.listSections(shotId)).filter(
      (row) => row.selectedAt
    );
    expect(selected.map((row) => row.id)).toEqual([second.sections[0]?.id]);
  });

  it('lists a shot’s readings newest first with the recording url', async () => {
    const methods = createShotDialogueMethods(db);
    const older = section(shotId, true);
    const newer = section(shotId, true);
    await methods.appendRecording(
      recording([older], { url: '/r2/audio/a.wav' })
    );
    await db
      .update(shotDialogueSections)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(shotDialogueSections.id, older.id));
    await methods.appendRecording(
      recording([newer], { url: '/r2/audio/b.wav' })
    );

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
    await methods.appendRecording(recording([own]));
    const context = section(otherShotId, false);
    await methods.appendRecording(recording([section(shotId, true), context]));

    const picked = await methods.selectSection(otherShotId, context.id);
    expect(picked.id).toBe(context.id);
    const selected = (await methods.listSections(otherShotId)).filter(
      (row) => row.selectedAt
    );
    expect(selected.map((row) => row.id)).toEqual([context.id]);
    // The other shot's selection is its own.
    expect(
      (await methods.listSections(shotId)).filter((row) => row.selectedAt)
    ).toHaveLength(1);
  });

  it('refuses a discarded section, and discarding clears the selection', async () => {
    const methods = createShotDialogueMethods(db);
    const mine = section(shotId, true);
    await methods.appendRecording(recording([mine]));
    await methods.discardSection(shotId, mine.id);

    expect(await methods.listSections(shotId)).toEqual([]);
    const stored = await methods.getSectionById(mine.id);
    expect(stored?.selectedAt).toBeNull();
    expect(stored?.discardedAt).toBeInstanceOf(Date);
    await expect(methods.selectSection(shotId, mine.id)).rejects.toThrow(
      /discarded/
    );
  });

  it('refuses a section of another shot, for select and for discard', async () => {
    const methods = createShotDialogueMethods(db);
    const theirs = section(otherShotId, true);
    await methods.appendRecording(recording([theirs]));

    await expect(methods.selectSection(shotId, theirs.id)).rejects.toThrow(
      /not found/
    );
    await methods.discardSection(shotId, theirs.id);
    expect((await methods.getSectionById(theirs.id))?.discardedAt).toBeNull();
  });

  it('returns null for a section that does not exist', async () => {
    const methods = createShotDialogueMethods(db);
    expect(await methods.getSectionById('missing')).toBeNull();
  });
});
