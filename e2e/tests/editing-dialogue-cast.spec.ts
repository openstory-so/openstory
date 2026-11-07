/**
 * Editing dialogue, cast and locations (#2243): one generated two-scene
 * sequence with two speakers, edited in the UI and through MCP. Each edit
 * names what goes out of date and what stays fresh, and that every shot lists
 * exactly its own lines. A second sequence casts the same character.
 * Runs in the full pipeline (one recorded run). Stops at the script stage:
 * dialogue audio (ElevenLabs Text to Dialogue) has no aimock route yet.
 */
import type {
  APIRequestContext,
  BrowserContext,
  Locator,
  Page,
} from 'playwright/test';
import { z } from 'zod';
import { E2E_RECORDING } from '../recording-mode';
import { call } from '../fixtures/mcp';
import {
  authenticateUser,
  cleanupTestUser,
  createTestUser,
  expect as baseExpect,
  test,
} from '../fixtures/auth.fixture';
// These drive live workflows under parallel specs; UI reads settle slowly.
const expect = baseExpect.configure({ timeout: 30_000 });
import { HYDRATION_TIMEOUT } from '../fixtures/test-utils';

const SCRIPT = `
INT. CORNER DINER - NIGHT

MAYA, 30s, a waitress in a grey t-shirt and red apron, wipes down the chrome counter. DEV, 40s, a long-haul driver in a canvas jacket, sits on the last stool.

MAYA
You're late. The kitchen closed an hour ago.

DEV
Then I'll take coffee and an argument.

MAYA
Coffee's free. The argument costs extra.

EXT. DINER CAR PARK - NIGHT

Rain on gravel. DEV stands beside his truck. MAYA steps out and flips the sign to closed.

MAYA
Take the pie. It won't keep.

DEV
You're a hard woman to say no to.
`.trim();

const SECOND_SCRIPT = `
INT. CORNER DINER - DAY

MAYA balances three plates along her arm and bumps the kitchen door open with her hip.

MAYA
Order up. Mind the gravy.
`.trim();

const EDITED = 'Then I will take coffee, an argument and a slice of pie.';

const Created = z.object({ sequences: z.array(z.object({ id: z.string() })) });
const Scenes = z.object({
  scenes: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
});
const Shots = z.object({
  shots: z.array(z.object({ id: z.string(), sceneId: z.string() })),
});
const Staleness = z.object({
  shots: z.array(
    z.object({
      shotId: z.string(),
      visualPrompt: z.string(),
      motionPrompt: z.string(),
      causes: z.array(z.string()),
    })
  ),
});
const Dialogue = z.object({
  selectedVersionId: z.string().nullable(),
  versions: z.array(
    z.object({
      id: z.string(),
      lines: z.array(z.object({ character: z.string(), line: z.string() })),
    })
  ),
});
const Cast = z.object({
  characters: z.array(z.object({ id: z.string(), name: z.string() })),
});
const Places = z.object({
  locations: z.array(z.object({ id: z.string(), name: z.string() })),
});
const Looks = z.object({ lookId: z.string() });

type Row = {
  id: string;
  scene: string;
  visual: string;
  motion: string;
  causes: string[];
  lines: string[];
};

let user: Awaited<ReturnType<typeof createTestUser>>;
let context: BrowserContext;
let page: Page;
let request: APIRequestContext;
let firstId = '';
let secondId = '';
let sceneIds: string[] = [];
let castIds: Record<string, string> = {};
let placeIds: Record<string, string> = {};
/** A blank shot added to take a moved line; it has no prompts to go stale. */
let addedShotId = '';

const seq = (id: string) => ({ sequenceId: id });

/** Every shot of a sequence with its verdicts and spoken lines, scene order. */
async function readShots(sequenceId: string): Promise<Row[]> {
  const s = seq(sequenceId);
  const { scenes } = await call(
    request,
    'list_scenes',
    { ...s, limit: 50 },
    Scenes
  );
  const { shots } = await call(
    request,
    'list_shots',
    { ...s, limit: 50 },
    Shots
  );
  const { shots: verdicts } = await call(
    request,
    'list_shot_staleness',
    { ...s, limit: 20 },
    Staleness
  );
  const rows: Row[] = [];
  for (const scene of scenes) {
    for (const shot of shots.filter((x) => x.sceneId === scene.id)) {
      const verdict = verdicts.find((v) => v.shotId === shot.id);
      if (!verdict) throw new Error(`no verdict for shot ${shot.id}`);
      const dialogue = await call(
        request,
        'list_shot_dialogue',
        { ...s, shotId: shot.id },
        Dialogue
      );
      const selected = dialogue.versions.find(
        (v) => v.id === dialogue.selectedVersionId
      );
      rows.push({
        id: shot.id,
        scene: scene.id,
        visual: verdict.visualPrompt,
        motion: verdict.motionPrompt,
        causes: verdict.causes,
        lines: selected?.lines.map((l) => `${l.character}: ${l.line}`) ?? [],
      });
    }
  }
  return rows;
}

const inScene = (rows: Row[], scene: string | undefined) =>
  rows.filter((r) => r.scene === scene);

const shotWith = (rows: Row[], text: string): Row => {
  const row = rows.find((r) => r.lines.some((l) => l.includes(text)));
  if (!row) throw new Error(`no shot says "${text}"`);
  return row;
};

/** Waits for the sequence workflow to finish with every shot written. */
async function settle(sequenceId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = await call(
          request,
          'get_sequence_status',
          seq(sequenceId),
          z.object({
            status: z.string(),
            counts: z.object({ shots: z.number() }),
          })
        );
        expect(status.status).not.toBe('failed');
        return status.status === 'completed' && status.counts.shots > 0;
      },
      {
        timeout: E2E_RECORDING ? 15 * 60_000 : 100_000,
        intervals: [2_000, 5_000, 10_000],
      }
    )
    .toBe(true);
}

async function createSequence(
  title: string,
  script: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const created = await call(
    request,
    'create_sequence',
    {
      script,
      title,
      enhance: 'off',
      style: 'Documentary',
      stopAt: 'script',
      startFrames: true,
      analysisModels: ['openai/gpt-6-luna'],
      imageModels: ['grok_imagine_image'],
      ...extra,
    },
    Created
  );
  const id = created.sequences[0]?.id ?? '';
  expect(id).not.toBe('');
  await settle(id);
  return id;
}

/** Opens one shot's panel once the client has hydrated. */
async function openShot(sequenceId: string, shotId: string): Promise<void> {
  await page.goto(`/sequences/${sequenceId}/scenes?shot=${shotId}`);
  await expect(page.getByRole('button', { name: 'Add line' })).toBeVisible({
    timeout: HYDRATION_TIMEOUT,
  });
}

// A click before hydration does nothing; retry until what it opens is there.
async function clickUntil(button: Locator, next: Locator): Promise<void> {
  await expect(async () => {
    if (!(await next.isVisible())) await button.click();
    await expect(next).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

const editButtons = () =>
  page.getByRole('button', { name: /^Edit .+'s line$/ });
const saveLine = () =>
  page.getByRole('button', { name: 'Save', exact: true }).click();

/** The shot's lines as the API sees them, once they equal `want`. */
async function expectLines(shotId: string, want: string[]): Promise<void> {
  await expect
    .poll(
      async () =>
        (await readShots(firstId)).find((r) => r.id === shotId)?.lines,
      { timeout: 20_000, message: `lines of ${shotId}` }
    )
    .toEqual(want);
}

test.describe('Editing dialogue and cast', () => {
  test.skip(
    process.env.PLAYWRIGHT_FULL_PIPELINE !== 'true',
    'Workflows run only in the full pipeline (`bun test:e2e:full`).'
  );
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(E2E_RECORDING ? 5 * 60_000 : 120_000);

  test.afterAll(async () => {
    if (!user) return;
    await fetch('http://localhost:3020/api/test/sequence', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: user.organizationId }),
    });
    await cleanupTestUser(user.id, user.organizationId);
    await context?.close();
  });

  test('a generated sequence gives every shot exactly its own lines', async ({
    browser,
  }) => {
    test.setTimeout(E2E_RECORDING ? 30 * 60_000 : 120_000);
    user = await createTestUser({ name: 'E2E Dialogue Editor' });
    context = await browser.newContext({
      baseURL: 'http://localhost:3020',
      storageState: { cookies: [], origins: [] },
    });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await authenticateUser(page, user.email);
    request = context.request;

    firstId = await createSequence('Diner dialogue', SCRIPT);
    const rows = await readShots(firstId);
    sceneIds = [...new Set(rows.map((r) => r.scene))];
    expect(sceneIds).toHaveLength(2);

    // Nothing is out of date, and no line sits on two shots.
    for (const row of rows) {
      expect(row, 'fresh').toMatchObject({ visual: 'fresh', motion: 'fresh' });
    }
    const spoken = rows.flatMap((r) => r.lines);
    expect(new Set(spoken).size).toBe(spoken.length);
    // Each scene's script lines are on that scene's shots.
    const first = inScene(rows, sceneIds[0]).flatMap((r) => r.lines);
    const second = inScene(rows, sceneIds[1]).flatMap((r) => r.lines);
    expect(first.join(' ')).toContain('kitchen closed an hour ago');
    expect(first.join(' ')).toContain('coffee and an argument');
    expect(first.join(' ')).toContain('argument costs extra');
    expect(second.join(' ')).toContain("Take the pie. It won't keep.");
    expect(second.join(' ')).toContain('hard woman to say no to');

    const { characters } = await call(
      request,
      'list_characters',
      seq(firstId),
      Cast
    );
    castIds = Object.fromEntries(characters.map((c) => [c.name, c.id]));
    expect(Object.keys(castIds).sort()).toEqual(['DEV', 'MAYA']);
    const { locations } = await call(
      request,
      'list_locations',
      seq(firstId),
      Places
    );
    placeIds = Object.fromEntries(locations.map((l) => [l.name, l.id]));
    expect(Object.keys(placeIds).sort()).toEqual([
      'CORNER DINER',
      'DINER CAR PARK',
    ]);

    // The dialogue block under the player lists them scene by scene.
    await page.goto(`/sequences/${firstId}/scenes`);
    const block = page.getByRole('region', { name: 'Dialogue' });
    await expect(block).toBeVisible({ timeout: 30_000 });
    for (const line of spoken) {
      await expect(block).toContainText(line.replace(/^[A-Z]+: /, ''));
    }
  });

  test('editing a line in the UI makes only that shot motion prompt out of date; history restores it', async () => {
    const before = await readShots(firstId);
    const target = shotWith(before, 'coffee and an argument');
    await openShot(firstId, target.id);

    const dev = page.getByRole('button', { name: "Edit DEV's line" });
    const words = page.getByRole('textbox', { name: /^Line \d+ words$/ });
    await clickUntil(dev, words);
    await words.fill(EDITED);
    await saveLine();
    await expectLines(
      target.id,
      target.lines.map((l) => (l.includes('coffee') ? `DEV: ${EDITED}` : l))
    );

    // The motion prompt reads the lines; the picture does not.
    const edited = await readShots(firstId);
    const row = edited.find((r) => r.id === target.id);
    expect(row).toMatchObject({ visual: 'fresh', motion: 'stale' });
    expect(row?.causes.join(' ')).toContain('Dialogue');
    for (const other of edited.filter((r) => r.id !== target.id)) {
      expect(other, 'other shots').toMatchObject({
        visual: 'fresh',
        motion: 'fresh',
        lines: before.find((r) => r.id === other.id)?.lines,
      });
    }
    await expect(page.getByText('Outdated')).toBeVisible();

    // Use the version from the script: the old words and a fresh prompt.
    const history = page.getByRole('region', { name: 'Dialogue history' });
    await history
      .getByRole('button', { name: /^Use lines from/ })
      .last()
      .click();
    await expectLines(target.id, target.lines);
    await expect
      .poll(async () => (await readShots(firstId)).map((r) => r.motion))
      .toEqual(before.map(() => 'fresh'));
  });

  test('a line moves between shots and changes speaker; each shot keeps only its own', async () => {
    const rows = await readShots(firstId);
    const scene = sceneIds[0];
    // The recorded analysis may give a scene one shot; a second shot takes the move.
    if (inScene(rows, scene).length < 2) {
      const added = await call(
        request,
        'create_shot',
        { ...seq(firstId), sceneId: scene, durationSeconds: 4 },
        z.object({ shotId: z.string() })
      );
      addedShotId = added.shotId;
    }
    const shots = inScene(await readShots(firstId), scene);
    const from = shotWith(shots, 'argument costs extra');
    const to = shots.find((r) => r.id !== from.id);
    if (!to) throw new Error('scene needs a second shot');
    const moved = from.lines.find((l) => l.includes('argument costs extra'));
    if (!moved) throw new Error('line not found');
    const words = moved.replace(/^[A-Z]+: /, '');

    // Take the line off the first shot...
    await openShot(firstId, from.id);
    const at = from.lines.indexOf(moved);
    const remove = page.getByRole('button', { name: 'Remove', exact: true });
    await clickUntil(editButtons().nth(at), remove);
    await remove.click();
    await expectLines(
      from.id,
      from.lines.filter((l) => l !== moved)
    );

    // ...and put it on the other, first by the wrong speaker.
    await openShot(firstId, to.id);
    const newWords = page.getByRole('textbox', { name: /^Line \d+ words$/ });
    await clickUntil(page.getByRole('button', { name: 'Add line' }), newWords);
    await newWords.fill(words);
    await page.getByRole('combobox', { name: /^Line \d+ character$/ }).click();
    await page.getByRole('option', { name: 'DEV' }).click();
    await saveLine();
    await expectLines(to.id, [...to.lines, `DEV: ${words}`]);

    await editButtons().last().click();
    await page.getByRole('combobox', { name: /^Line \d+ character$/ }).click();
    await page.getByRole('option', { name: 'MAYA' }).click();
    await saveLine();
    await expectLines(to.id, [...to.lines, `MAYA: ${words}`]);

    // The line is on one shot only; the other scene is untouched.
    const after = await readShots(firstId);
    expect(after.filter((r) => r.lines.includes(`MAYA: ${words}`))).toEqual([
      expect.objectContaining({ id: to.id }),
    ]);
    for (const row of inScene(after, sceneIds[1])) {
      expect(row).toMatchObject({ visual: 'fresh', motion: 'fresh' });
    }
    // The scene's dialogue block shows the line once, under its scene.
    await page.goto(`/sequences/${firstId}/scenes`);
    const block = page.getByRole('region', { name: 'Dialogue' });
    await expect(block.getByText(words)).toHaveCount(1, { timeout: 30_000 });
  });

  // Bug #2293: after update_location the diner shots' prompts read untracked, not stale.
  test.fixme('editing a location marks only the scenes there out of date', async () => {
    await call(request, 'update_location', {
      ...seq(firstId),
      locationId: placeIds['CORNER DINER'],
      ambiance: 'Warm amber light and steam from the coffee machine.',
    });
    const rows = await readShots(firstId);
    for (const row of inScene(rows, sceneIds[0])) {
      expect(row, 'diner scene').toMatchObject({
        visual: 'stale',
        motion: 'stale',
      });
      expect(row.causes.join(' ')).toContain('Location "CORNER DINER"');
    }
    for (const row of inScene(rows, sceneIds[1])) {
      expect(row, 'car park scene').toMatchObject({
        visual: 'fresh',
        motion: 'fresh',
      });
    }
    await page.goto(`/sequences/${firstId}/scenes`);
    await expect(page.getByTestId('scene-stale-shots')).toContainText(
      'Out of date since your edit',
      { timeout: 30_000 }
    );
  });

  test('a look is worn per scene: editing it unworn changes nothing, switching a scene stales that scene', async () => {
    const maya = castIds['MAYA'];
    if (!maya) throw new Error('MAYA not cast');
    const { lookId } = await call(
      request,
      'create_character_look',
      {
        ...seq(firstId),
        characterId: maya,
        name: 'Rain coat',
        clothing: 'Yellow rain slicker over the grey t-shirt.',
        styling: 'Hair damp from the rain.',
      },
      Looks
    );
    const before = await readShots(firstId);
    await call(request, 'update_character_look', {
      ...seq(firstId),
      characterId: maya,
      lookId,
      clothing: 'Yellow rain slicker, apron folded under one arm.',
    });
    const unworn = await readShots(firstId);
    // No scene wears it, so no verdict moves.
    expect(unworn.map((r) => [r.visual, r.motion])).toEqual(
      before.map((r) => [r.visual, r.motion])
    );

    const { scenes } = await call(
      request,
      'list_scenes',
      { ...seq(firstId), limit: 50 },
      z.object({
        scenes: z.array(
          z.object({ id: z.string(), selectedScriptVersionId: z.string() })
        ),
      })
    );
    const car = scenes.find((x) => x.id === sceneIds[1]);
    await call(request, 'update_scene', {
      ...seq(firstId),
      sceneId: sceneIds[1],
      expectedScriptVersionId: car?.selectedScriptVersionId,
      continuity: { characterLooks: { [maya]: lookId } },
    });
    const after = await readShots(firstId);
    for (const row of inScene(after, sceneIds[1])) {
      expect(row, 'scene in the rain coat').toMatchObject({
        visual: 'stale',
        motion: 'stale',
      });
    }
    // The diner scene never mentions the new look.
    for (const row of inScene(after, sceneIds[0])) {
      expect(row.causes.join(' ')).not.toContain('Rain coat');
    }
  });

  test('a character edit follows her into a second sequence and leaves the other speaker alone', async () => {
    // Analysis never reuses a character by itself; she is attached at create.
    secondId = await createSequence('Diner lunch', SECOND_SCRIPT, {
      characters: [castIds['MAYA']],
    });
    const cast = await call(request, 'list_characters', seq(secondId), Cast);
    expect(cast.characters.map((c) => c.id)).toContain(castIds['MAYA']);
    const base = await readShots(secondId);
    for (const row of base) {
      expect(row, 'second sequence').toMatchObject({
        visual: 'fresh',
        motion: 'fresh',
      });
    }

    // DEV is not in the second sequence: editing him changes nothing there.
    await call(request, 'update_character', {
      ...seq(firstId),
      characterId: castIds['DEV'],
      voiceOnly: false,
      personality: 'Wry, tired and quietly kind.',
    });
    for (const row of await readShots(secondId)) {
      expect(row, 'second sequence after DEV').toMatchObject({
        visual: 'fresh',
        motion: 'fresh',
      });
    }

    // MAYA is in both: a personality edit stales motion prompts only...
    await call(request, 'update_character', {
      ...seq(firstId),
      characterId: castIds['MAYA'],
      voiceOnly: false,
      personality: 'Dry, patient and secretly generous.',
    });
    for (const row of await readShots(secondId)) {
      expect(row, 'personality').toMatchObject({
        visual: 'fresh',
        motion: 'stale',
      });
      expect(row.causes.join(' ')).toContain('Character "MAYA": personality');
    }

    // ...and a description edit stales the picture prompts too, in both.
    await call(request, 'update_character', {
      ...seq(firstId),
      characterId: castIds['MAYA'],
      voiceOnly: false,
      physicalDescription: 'Woman in her 30s, lean, dark hair in a short bob.',
    });
    // Her shots are picked by her lines, not by the causes under test.
    for (const id of [firstId, secondId]) {
      const hers = (await readShots(id)).filter(
        (r) =>
          r.id !== addedShotId && r.lines.some((l) => l.startsWith('MAYA:'))
      );
      expect(hers.length, `MAYA speaks in ${id}`).toBeGreaterThan(0);
      for (const row of hers) {
        expect(row, `description in ${id}`).toMatchObject({
          visual: 'stale',
          motion: 'stale',
        });
        expect(row.causes.join(' ')).toMatch(/Character "MAYA".*description/);
      }
    }
    await page.goto(`/sequences/${secondId}/scenes`);
    await expect(page.getByTestId('scene-stale-shots')).toContainText(
      'Out of date since your edit',
      { timeout: 30_000 }
    );
  });

  test('replacing a character in the second sequence re-points the cast and stales its shots', async () => {
    await call(request, 'replace_character', {
      ...seq(secondId),
      characterId: castIds['MAYA'],
      withCharacterId: castIds['DEV'],
    });
    const cast = await call(request, 'list_characters', seq(secondId), Cast);
    expect(cast.characters.map((c) => c.name)).toEqual(['DEV']);
    for (const row of await readShots(secondId)) {
      expect(row.motion).toBe('stale');
      expect(row.causes.join(' ')).toContain('Character "DEV"');
    }
    // The first sequence still casts both.
    const kept = await call(request, 'list_characters', seq(firstId), Cast);
    expect(kept.characters.map((c) => c.name).sort()).toEqual(['DEV', 'MAYA']);
  });
});
