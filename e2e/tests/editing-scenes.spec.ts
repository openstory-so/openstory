/**
 * Editing scenes (#2243): one generated two-scene sequence, edited in the UI.
 * Each edit names what goes out of date, what stays fresh, and that a scene's
 * dialogue lines stay with it. Runs in the full pipeline (one recorded run).
 */
import type { APIRequestContext, BrowserContext, Page } from 'playwright/test';
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
import { RECORDED_PIPELINE_SETTINGS } from '../fixtures/test-utils';

const SCRIPT = `
INT. NEWSROOM - NIGHT

MARA, a tired editor in a green cardigan, stares at a monitor. DEV, a young reporter, rushes in with a laptop.

DEV
We have the leaked memo. It names the mayor.

MARA
Then we run it at six.

EXT. CITY HALL STEPS - MORNING

MARA and DEV climb the steps past a row of cameras. A spokesperson blocks the door.

SPOKESPERSON
No comment.

MARA
We did not ask a question yet.
`.trim();

const ADDED_BEAT = 'A cameraman lowers his lens.';

const Scenes = z.object({
  scenes: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
});
const Shots = z.object({
  shots: z.array(
    z.object({
      id: z.string(),
      sceneId: z.string(),
      shotNumber: z.number(),
      anchorFrame: z
        .object({
          selectedImage: z.object({ versionId: z.string().nullable() }),
        })
        .nullable(),
    })
  ),
});
const Staleness = z.object({
  shots: z.array(
    z.object({
      shotId: z.string(),
      thumbnail: z.string(),
      visualPrompt: z.string(),
      motionPrompt: z.string(),
      dialogue: z.string(),
    })
  ),
});
const Dialogue = z.object({
  selectedVersionId: z.string().nullable(),
  versions: z.array(
    z.object({
      id: z.string(),
      lines: z.array(z.object({ line: z.string() })),
    })
  ),
});

type Verdicts = {
  thumbnail: string;
  visualPrompt: string;
  motionPrompt: string;
  dialogue: string;
};
const VERDICT_KEYS = [
  'thumbnail',
  'visualPrompt',
  'motionPrompt',
  'dialogue',
] as const satisfies readonly (keyof Verdicts)[];
type ShotState = Verdicts & {
  id: string;
  sceneId: string;
  number: number;
  still: string | null;
  lines: string[];
};

const FRESH = {
  thumbnail: 'fresh',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
};

let user: Awaited<ReturnType<typeof createTestUser>>;
let context: BrowserContext;
let page: Page;
let request: APIRequestContext;
let sequenceId = '';
/** Scene ids in their original order. */
let sceneIds: string[] = [];
/** The verdicts after the last edit, so the next one proves what it left alone. */
let last: ShotState[] = [];

const s = () => ({ sequenceId });

/** Every live shot with its verdicts, in scene then shot order. */
async function readShots(): Promise<ShotState[]> {
  const { scenes } = await call(
    request,
    'list_scenes',
    { ...s(), limit: 50 },
    Scenes
  );
  const { shots } = await call(
    request,
    'list_shots',
    { ...s(), limit: 20 },
    Shots
  );
  const { shots: verdicts } = await call(
    request,
    'list_shot_staleness',
    { ...s(), limit: 20 },
    Staleness
  );
  const out: ShotState[] = [];
  for (const scene of scenes) {
    for (const shot of shots.filter((x) => x.sceneId === scene.id)) {
      const verdict = verdicts.find((v) => v.shotId === shot.id);
      if (!verdict) throw new Error(`no verdict for shot ${shot.id}`);
      const dialogue = await call(
        request,
        'list_shot_dialogue',
        { ...s(), shotId: shot.id },
        Dialogue
      );
      const selected = dialogue.versions.find(
        (v) => v.id === dialogue.selectedVersionId
      );
      out.push({
        ...verdict,
        id: shot.id,
        sceneId: scene.id,
        number: shot.shotNumber,
        still: shot.anchorFrame?.selectedImage.versionId ?? null,
        lines: selected?.lines.map((l) => l.line) ?? [],
      });
    }
  }
  return out;
}

const inScene = (rows: ShotState[], id: string) =>
  rows.filter((r) => r.sceneId === id);

const verdictsOf = (rows: ShotState[]) =>
  rows.map(
    ({ id, thumbnail, visualPrompt, motionPrompt, dialogue, lines }) => ({
      id,
      thumbnail,
      visualPrompt,
      motionPrompt,
      dialogue,
      lines,
    })
  );

/** Polls until every shot of the scene matches `want`. */
async function expectSceneVerdicts(
  id: string,
  want: Partial<Verdicts>
): Promise<void> {
  await expect
    .poll(
      async () =>
        inScene(await readShots(), id).every((r) =>
          VERDICT_KEYS.every((k) => want[k] === undefined || r[k] === want[k])
        ),
      {
        message: `${id}: ${JSON.stringify(want)}`,
        timeout: E2E_RECORDING ? 300_000 : 60_000,
        intervals: [2_000, 5_000],
      }
    )
    .toBe(true);
}

const group = (id: string) => page.locator(`[data-scene-id="${id}"]`);

/** The label the scene list shows for a scene. */
async function labelOf(id: string): Promise<string> {
  const aria = await group(id)
    .getByRole('button', { name: /^Scene actions for / })
    .getAttribute('aria-label');
  return (aria ?? '').replace('Scene actions for ', '');
}

/** The dialogue block under the player: scenes in order, each with its lines. */
async function expectDialogueOrder(
  rows: ShotState[],
  order: string[]
): Promise<void> {
  // A selected scene shows only its own lines; a fresh load shows them all.
  await openScenes();
  const block = page.getByRole('region', { name: 'Dialogue' }).first();
  await expect(block).toBeVisible({ timeout: 15_000 });
  const text = (await block.innerText()).replace(/\s+/g, ' ').toLowerCase();
  let at = -1;
  for (const id of order) {
    const heading = text.indexOf((await labelOf(id)).toLowerCase(), at + 1);
    expect(heading, `${id} heading after offset ${at}`).toBeGreaterThan(at);
    at = heading;
    for (const line of inScene(rows, id).flatMap((r) => r.lines)) {
      const found = text.indexOf(line.toLowerCase(), at);
      expect(found, `"${line}" under ${id}`).toBeGreaterThanOrEqual(at);
      at = found;
    }
  }
}

async function openScenes(): Promise<void> {
  await page.goto(`/sequences/${sequenceId}/scenes`, { timeout: 60_000 });
  await expect(page.locator('[data-testid="scene-group"]').first()).toBeVisible(
    {
      timeout: 30_000,
    }
  );
}

async function sceneAction(id: string, item: string): Promise<void> {
  const menuItem = page.getByRole('menuitem', { name: item });
  // A click before hydration opens nothing; retry until the menu is there.
  await expect(async () => {
    if (!(await menuItem.isVisible())) {
      await group(id)
        .getByRole('button', { name: /^Scene actions for / })
        .click();
    }
    await expect(menuItem).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await menuItem.click();
}

/** Selects the scene and returns its Script tab. */
async function openSceneScript(id: string) {
  const title = await labelOf(id);
  // The first click right after load can be swallowed, so click until selected.
  await expect(async () => {
    if (!(await group(id).getAttribute('class'))?.includes('border-primary')) {
      await group(id).getByRole('button', { name: title, exact: true }).click();
    }
    await expect(group(id)).toHaveClass(/border-primary/, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const panel = page.getByRole('tabpanel', { name: 'Script' });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('Editing scenes', () => {
  test.skip(
    process.env.PLAYWRIGHT_FULL_PIPELINE !== 'true',
    'Workflows run only in the full pipeline (`bun test:e2e:full`).'
  );
  test.describe.configure({ mode: 'serial' });
  test.use({ actionTimeout: 15_000 });
  test.setTimeout(E2E_RECORDING ? 30 * 60_000 : 120_000);

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

  test('a generated two-scene sequence starts fresh, each scene with its own lines', async ({
    browser,
  }) => {
    user = await createTestUser({ name: 'E2E Scene Editor' });
    context = await browser.newContext({
      baseURL: 'http://localhost:3020',
      storageState: { cookies: [], origins: [] },
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await authenticateUser(page, user.email);
    request = context.request;

    const created = await call(
      request,
      'create_sequence',
      {
        script: SCRIPT,
        title: 'Scene editing',
        enhance: 'off',
        style: 'Documentary',
        stopAt: 'images',
        startFrames: true,
        analysisModels: [...RECORDED_PIPELINE_SETTINGS.analysisModels],
        imageModels: ['nano_banana_2_lite'],
      },
      z.object({ sequences: z.array(z.object({ id: z.string() })) })
    );
    sequenceId = created.sequences[0]?.id ?? '';
    expect(sequenceId).not.toBe('');

    await expect
      .poll(
        async () => {
          const status = await call(
            request,
            'get_sequence_status',
            s(),
            z.object({
              status: z.string(),
              counts: z.object({ shots: z.number(), imagesReady: z.number() }),
            })
          );
          expect(status.status).not.toBe('failed');
          return (
            status.status === 'completed' &&
            status.counts.shots > 0 &&
            status.counts.imagesReady === status.counts.shots
          );
        },
        {
          timeout: E2E_RECORDING ? 8 * 60_000 : 100_000,
          intervals: [2_000, 5_000, 10_000],
        }
      )
      .toBe(true);

    const rows = await readShots();
    sceneIds = [...new Set(rows.map((r) => r.sceneId))];
    expect(sceneIds).toHaveLength(2);
    for (const row of rows) {
      expect(row, `shot ${row.number}`).toMatchObject(FRESH);
    }
    // Only the spoken lines are on shots: each scene has some, in its own shots.
    for (const id of sceneIds) {
      expect(inScene(rows, id).flatMap((r) => r.lines).length).toBeGreaterThan(
        0
      );
    }
    last = rows;

    await openScenes();
    await expect(
      page.getByRole('button', { name: /out of date$/ })
    ).toHaveCount(0);
    await expectDialogueOrder(rows, sceneIds);
  });

  test('editing one scene script marks only that scene out of date; its lines are kept', async () => {
    const [first, second] = sceneIds;
    if (!first || !second) throw new Error('scenes not set up');

    const panel = await openSceneScript(second);
    const editor = panel.locator('[contenteditable="true"]').first();
    // Caret to the very end; Meta+End does not move it on macOS.
    await editor.evaluate((el: HTMLElement) => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
    await page.keyboard.press('Enter');
    await page.keyboard.type(ADDED_BEAT);
    await panel.getByRole('button', { name: 'Save', exact: true }).click();

    await expectSceneVerdicts(second, {
      visualPrompt: 'stale',
      motionPrompt: 'stale',
    });
    const after = await readShots();
    // A still is judged by its prompt text, which has not been rewritten yet.
    expect(inScene(after, second).every((r) => r.thumbnail === 'fresh')).toBe(
      true
    );
    expect(verdictsOf(inScene(after, first))).toEqual(
      verdictsOf(inScene(last, first))
    );
    // The scene script is the story text; the shot's spoken lines are not rewritten by it.
    expect(after.map((r) => r.lines)).toEqual(last.map((r) => r.lines));

    await expect(
      page.getByRole('button', { name: /^Open shot \d — out of date$/ })
    ).toHaveCount(inScene(after, second).length);
    last = after;
  });

  test('Update all (prompts only) brings the edited scene back and leaves the other scene alone', async () => {
    const [first, second] = sceneIds;
    if (!first || !second) throw new Error('scenes not set up');

    await page
      .getByRole('button', { name: 'Update all out-of-date shots' })
      .click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Update out-of-date items');
    // Unticking Images drops it and everything deeper: rewrite prompts only.
    const images = dialog.getByRole('checkbox', { name: /images/i });
    if (await images.isChecked()) await images.uncheck();
    await dialog.getByRole('button', { name: /^Update/ }).click();

    await expectSceneVerdicts(second, {
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
    const after = await readShots();
    expect(verdictsOf(inScene(after, first))).toEqual(
      verdictsOf(inScene(last, first))
    );
    for (const row of after) {
      expect(row.still, 'no still was redrawn').toBe(
        last.find((r) => r.id === row.id)?.still
      );
    }
    expect(after.map((r) => r.lines)).toEqual(last.map((r) => r.lines));
    last = after;
  });

  test('renaming a scene changes only its title', async () => {
    const [first] = sceneIds;
    if (!first) throw new Error('scenes not set up');
    await sceneAction(first, 'Rename scene');
    const input = page.getByLabel('Scene title');
    await input.fill('Opening');
    await input.press('Enter');
    await expect(
      group(first)
        .getByRole('button', { name: /^Opening/ })
        .first()
    ).toBeVisible();

    const rows = await readShots();
    expect(verdictsOf(rows)).toEqual(verdictsOf(last));
  });

  test('moving a scene down takes its lines with it and stales no shot', async () => {
    const [first, second] = sceneIds;
    if (!first || !second) throw new Error('scenes not set up');

    await sceneAction(first, 'Move down');
    await expect
      .poll(async () => {
        const { scenes } = await call(
          request,
          'list_scenes',
          { ...s(), limit: 50 },
          Scenes
        );
        return scenes.map((x) => x.id);
      })
      .toEqual([second, first]);

    const rows = await readShots();
    expect(verdictsOf(rows).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      verdictsOf(last).sort((a, b) => a.id.localeCompare(b.id))
    );
    await expectDialogueOrder(rows, [second, first]);

    await sceneAction(first, 'Move up');
    await expect
      .poll(async () => {
        const { scenes } = await call(
          request,
          'list_scenes',
          { ...s(), limit: 50 },
          Scenes
        );
        return scenes.map((x) => x.id);
      })
      .toEqual([first, second]);
  });

  test('removing a scene hides its shots and lines, and Undo brings them back unchanged', async () => {
    const [first, second] = sceneIds;
    if (!first || !second) throw new Error('scenes not set up');
    const before = await readShots();

    await sceneAction(second, 'Remove scene');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(group(second)).toHaveCount(0);
    const block = page.getByRole('region', { name: 'Dialogue' }).first();
    for (const line of inScene(before, second).flatMap((r) => r.lines)) {
      await expect(block).not.toContainText(line);
    }
    expect(verdictsOf(await readShots())).toEqual(
      verdictsOf(inScene(before, first))
    );

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(group(second)).toHaveCount(1, { timeout: 15_000 });
    const rows = await readShots();
    expect(verdictsOf(rows)).toEqual(verdictsOf(before));
    await expectDialogueOrder(rows, [first, second]);
  });

  test('changing a scene time of day marks only that scene out of date', async () => {
    const [first, second] = sceneIds;
    if (!first || !second) throw new Error('scenes not set up');
    const before = await readShots();

    const panel = await openSceneScript(second);
    await panel.getByRole('textbox', { name: 'Time of day' }).fill('midday');
    await panel.getByRole('button', { name: 'Save setting' }).click();
    await expect(page.getByText('Scene setting saved')).toBeVisible();

    await expectSceneVerdicts(second, {
      visualPrompt: 'stale',
      motionPrompt: 'stale',
    });
    const after = await readShots();
    expect(verdictsOf(inScene(after, first))).toEqual(
      verdictsOf(inScene(before, first))
    );
    expect(after.map((r) => r.lines)).toEqual(before.map((r) => r.lines));
  });

  // Bug #2289: the scene Locations tab keeps listing the old location after the Scene location select moves.
  test.fixme('switching a scene location shows the new location on the scene', async () => {
    const second = sceneIds[1];
    if (!second) throw new Error('scenes not set up');
    await openSceneScript(second);
    await page
      .getByRole('combobox')
      .first()
      .selectOption({ label: 'Locations' });
    const select = page.getByRole('combobox', { name: 'Scene location' });
    const current = (await select.innerText()).trim();
    await select.click();
    await page
      .getByRole('option')
      .filter({ hasNotText: current })
      .first()
      .click();
    await page.reload();
    const chosen = (await select.innerText()).trim();
    expect(chosen).not.toBe(current);
    await expect(page.getByText(chosen).nth(1)).toBeVisible();
  });

  test('adding a scene leaves the other shots as they were', async () => {
    const before = await readShots();
    await page.getByRole('button', { name: 'Add scene' }).click();
    await expect(page.locator('[data-testid="scene-group"]')).toHaveCount(3);
    const rows = await readShots();
    expect(
      verdictsOf(rows.filter((r) => before.some((b) => b.id === r.id)))
    ).toEqual(verdictsOf(before));
  });

  test('Generate Copy opens the composer with the current script', async () => {
    await page.goto(`/sequences/${sequenceId}/script`, { timeout: 60_000 });
    const copy = `/sequences/new?from=${sequenceId}`;
    await expect(
      page.getByRole('link', { name: 'Generate Copy…' })
    ).toHaveAttribute('href', copy);
    // The composer route compiles slowly under parallel specs; go straight there.
    await page.goto(copy, { timeout: 60_000 });
    await expect(page.getByText(ADDED_BEAT, { exact: true })).toBeVisible();
  });
});
