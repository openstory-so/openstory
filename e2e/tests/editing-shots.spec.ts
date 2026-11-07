/**
 * Editing shots (#2243): one generated sequence (Seedream stills), edited a
 * shot at a time. Each edit names what goes out of date and what stays fresh.
 * Runs in the full pipeline (one recorded run).
 */
import type { APIRequestContext, BrowserContext, Page } from 'playwright/test';
import { z } from 'zod';
import { E2E_RECORDING } from '../recording-mode';
import { call, upload } from '../fixtures/mcp';
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
INT. BAKERY KITCHEN - EARLY MORNING

MARA, a baker in a flour-dusted apron, kneads dough on a steel bench. She glances at the wall clock.

MARA
We open in five minutes.

EXT. BAKERY STREET - MORNING

MARA flips the shop sign to OPEN and steps out into the morning light. A delivery cyclist waves from across the road.

CYCLIST
Smells amazing today!
`.trim();

const SUFFIX_WITH_DIALOGUE =
  'Generate only dialogue, environmental sounds, and action sounds.';
const SUFFIX_NO_DIALOGUE =
  'no dialogue. Generate only environmental sounds and action sounds.';

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
          id: z.string(),
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
      video: z.string(),
    })
  ),
});
const Dialogue = z.object({
  selectedVersionId: z.string().nullable(),
  versions: z.array(
    z.object({
      id: z.string(),
      lines: z.array(
        z.object({ character: z.string(), line: z.string(), tone: z.string() })
      ),
    })
  ),
});
const Versions = z.object({
  versions: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      selected: z.boolean(),
      error: z.string().nullable().optional(),
    })
  ),
});
const SpecRead = z.object({
  spec: z.looseObject({ action: z.string() }).nullable(),
  verdict: z.string(),
});

type Verdicts = {
  thumbnail: string;
  visualPrompt: string;
  motionPrompt: string;
  dialogue: string;
  video: string;
};
const VERDICT_KEYS = [
  'thumbnail',
  'visualPrompt',
  'motionPrompt',
  'dialogue',
  'video',
] as const satisfies readonly (keyof Verdicts)[];
type ShotState = Verdicts & {
  id: string;
  frameId: string;
  scene: string;
  number: number;
  still: string | null;
  lines: string[];
};

let user: Awaited<ReturnType<typeof createTestUser>>;
let context: BrowserContext;
let page: Page;
let request: APIRequestContext;
let sequenceId = '';

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
  for (const [index, scene] of scenes.entries()) {
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
        frameId: shot.anchorFrame?.id ?? '',
        scene: scene.title ?? `Scene ${index + 1}`,
        number: shot.shotNumber,
        still: shot.anchorFrame?.selectedImage.versionId ?? null,
        lines: selected?.lines.map((l) => l.line) ?? [],
      });
    }
  }
  return out;
}

const byId = (rows: ShotState[], id: string): ShotState => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`shot ${id} not found`);
  return row;
};

/** Polls until the shot's verdicts include `want`. */
async function expectShot(id: string, want: Partial<Verdicts>): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = byId(await readShots(), id);
        return Object.fromEntries(
          VERDICT_KEYS.filter((k) => k in want).map((k) => [k, row[k]])
        );
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toEqual(want);
}

/** Every shot other than `id` still reads `want`. */
async function expectOthers(
  id: string,
  want: Partial<Verdicts>
): Promise<void> {
  for (const row of (await readShots()).filter((r) => r.id !== id)) {
    expect(row, `${row.scene} shot ${row.number}`).toMatchObject(want);
  }
}

/** Polls until `count` versions are done. */
async function settleVersions(
  kind: string,
  entityId: string,
  count: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { versions } = await call(
          request,
          'list_versions',
          { ...s(), kind, entityId },
          Versions
        );
        const failed = versions.find((v) => v.status === 'failed');
        expect(failed?.error ?? null, `${kind} failed`).toBeNull();
        return versions.filter((v) => v.status === 'completed').length;
      },
      {
        timeout: E2E_RECORDING ? 600_000 : 60_000,
        intervals: [2_000, 5_000],
      }
    )
    .toBeGreaterThanOrEqual(count);
}

const sceneGroup = (title: string) =>
  page.locator('[data-testid="scene-group"]').filter({ hasText: title });

/** The shot's card link in the scene rail. */
const shotLink = (row: ShotState) =>
  sceneGroup(row.scene).getByRole('link', {
    name: new RegExp(`Shot ${row.number} ·`),
  });
// The link is an empty stretched anchor; the badge text lives on the card.
const shotCard = (row: ShotState) =>
  page.locator(`[data-testid="scene-list-item"][data-shot-id="${row.id}"]`);

async function openShot(row: ShotState): Promise<void> {
  await page.goto(`/sequences/${sequenceId}/scenes`);
  await expect(shotLink(row)).toBeVisible({ timeout: 30_000 });
  await shotLink(row).click();
  await expect(page).toHaveURL(new RegExp(`shot=${row.id}`));
}

const OUT_OF_DATE = 'Out of date since your last edit';

let target: ShotState; // the shot with a spoken line
let neighbour: ShotState; // any other shot
let freshStill = '';

test.describe('Editing shots', () => {
  test.skip(
    process.env.PLAYWRIGHT_FULL_PIPELINE !== 'true',
    'Workflows run only in the full pipeline (`bun test:e2e:full`).'
  );
  test.describe.configure({ mode: 'serial' });
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

  test('a generated sequence starts fresh, with its spoken lines on the right shots', async ({
    browser,
  }) => {
    user = await createTestUser({ name: 'E2E Shot Editor' });
    context = await browser.newContext({
      baseURL: 'http://localhost:3020',
      storageState: { cookies: [], origins: [] },
    });
    page = await context.newPage();
    await authenticateUser(page, user.email);
    request = context.request;

    const created = await call(
      request,
      'create_sequence',
      {
        script: SCRIPT,
        title: 'Shot editing',
        enhance: 'off',
        style: 'Documentary',
        stopAt: 'images',
        startFrames: true,
        analysisModels: [...RECORDED_PIPELINE_SETTINGS.analysisModels],
        imageModels: ['seedream_v5'],
        videoModels: ['seedance_v2_5'],
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
          timeout: E2E_RECORDING ? 25 * 60_000 : 100_000,
          intervals: [2_000, 5_000, 10_000],
        }
      )
      .toBe(true);

    const rows = await readShots();
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row, `${row.scene} shot ${row.number}`).toMatchObject({
        thumbnail: 'fresh',
        visualPrompt: 'fresh',
        motionPrompt: 'fresh',
      });
    }
    const speaking = rows.filter((r) => r.lines.length > 0);
    expect(speaking.length).toBeGreaterThan(0);
    const first = speaking[0];
    const other = rows.find((r) => r.id !== first?.id);
    if (!first || !other) throw new Error('need two shots');
    target = first;
    neighbour = other;
    expect(target.lines.join(' ')).toMatch(/five minutes|Smells amazing/);
    expect(
      (
        await call(
          request,
          'get_shot_spec',
          { ...s(), shotId: target.id },
          SpecRead
        )
      ).verdict
    ).toBe('current');
  });

  test('saving a shot action rebuilds its motion prompt for free and leaves every still current', async () => {
    await openShot(neighbour);
    const action = page.getByRole('textbox', { name: 'Action' }).first();
    await expect(action).toBeVisible({ timeout: 15_000 });
    await action.fill('She stops mid-motion and listens to the street.');
    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();

    const readSpec = () =>
      call(
        request,
        'get_shot_spec',
        { ...s(), shotId: neighbour.id },
        SpecRead
      );
    await expect
      .poll(async () => (await readSpec()).spec?.action, { timeout: 30_000 })
      .toBe('She stops mid-motion and listens to the street.');
    expect((await readSpec()).verdict).toBe('current');

    // Action feeds only the motion prompt, rebuilt in place; the still is untouched.
    await expectShot(neighbour.id, {
      thumbnail: 'fresh',
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
    await expect(shotCard(neighbour)).not.toContainText(OUT_OF_DATE);
    await expectOthers(neighbour.id, {
      thumbnail: 'fresh',
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
  });

  test('a hand-written visual prompt stales the still; restoring the derived one clears it', async () => {
    const before = byId(await readShots(), target.id);
    const { versions } = await call(
      request,
      'list_versions',
      { ...s(), kind: 'visual_prompt', entityId: before.frameId },
      Versions
    );
    const derived = versions.find((v) => v.selected);
    if (!derived) throw new Error('no selected visual prompt');

    await call(request, 'update_shot_prompt', {
      ...s(),
      shotId: target.id,
      promptType: 'visual',
      text: 'A baker kneading dough, soft window light, shallow focus.',
    });
    await expectShot(target.id, { thumbnail: 'stale', visualPrompt: 'fresh' });
    await openShot(target);
    await expect(shotCard(target)).toContainText(OUT_OF_DATE);

    await call(request, 'restore_shot_prompt_version', {
      ...s(),
      shotId: target.id,
      promptType: 'visual',
      versionId: derived.id,
    });
    await expectShot(target.id, { thumbnail: 'fresh', visualPrompt: 'fresh' });
    await page.reload();
    await expect(shotCard(target)).not.toContainText(OUT_OF_DATE);
  });

  test("a shot's motion prompt follows its lines: no lines means the no-dialogue suffix", async () => {
    const { selectedVersionId } = await call(
      request,
      'list_shot_dialogue',
      { ...s(), shotId: target.id },
      z.object({ selectedVersionId: z.string() })
    );
    await openShot(target);
    const optimised = page.getByRole('button', { name: /Optimised prompt/ });
    const openOptimised = async () => {
      await page.getByRole('tab', { name: 'Video' }).click();
      // A click before hydration does nothing, so retry until it opens.
      await expect(async () => {
        if ((await optimised.getAttribute('aria-expanded')) !== 'true') {
          await optimised.click();
        }
        await expect(optimised).toHaveAttribute('aria-expanded', 'true', {
          timeout: 2_000,
        });
      }).toPass({ timeout: 20_000 });
    };
    await openOptimised();
    const panel = page.getByRole('tabpanel', { name: 'Video' });
    await expect(panel).toContainText(SUFFIX_WITH_DIALOGUE);

    await call(request, 'update_shot_dialogue', {
      ...s(),
      shotId: target.id,
      lines: [],
    });
    await expectShot(target.id, { motionPrompt: 'stale' });
    // Bug #2294: the open preview does not refresh after a dialogue edit elsewhere.
    await page.reload();
    await openOptimised();
    await expect(panel).toContainText(SUFFIX_NO_DIALOGUE);
    await expect(panel).not.toContainText(SUFFIX_WITH_DIALOGUE);

    // The old lines version back: the suffix and the verdict both return.
    await call(request, 'select_shot_dialogue_version', {
      ...s(),
      shotId: target.id,
      versionId: selectedVersionId,
    });
    await expectShot(target.id, { motionPrompt: 'fresh' });
    await page.reload();
    await openOptimised();
    await expect(panel).toContainText(SUFFIX_WITH_DIALOGUE);
  });

  test('a clip goes stale when its still changes, and fresh when the old still returns', async () => {
    const row = byId(await readShots(), target.id);
    freshStill = row.still ?? '';
    expect(freshStill).not.toBe('');

    const clip = await upload(
      request,
      sequenceId,
      'shot_video',
      'test-video.mp4',
      'video/mp4'
    );
    await call(request, 'set_shot_video_from_upload', {
      ...s(),
      shotId: target.id,
      upload: clip,
    });
    await expectShot(target.id, { video: 'fresh' });

    // A second still on Ark: the clip no longer matches the selected still.
    await call(request, 'generate_shot_image', {
      ...s(),
      shotId: target.id,
      model: 'seedream_v5',
    });
    await settleVersions('image', row.frameId, 2);
    await expectShot(target.id, { thumbnail: 'fresh', video: 'stale' });
    await expectOthers(target.id, { video: 'untracked' });

    // Picking the earlier still brings the clip back in step.
    await call(request, 'select_shot_image_version', {
      ...s(),
      shotId: target.id,
      versionId: freshStill,
    });
    await expectShot(target.id, { video: 'fresh' });
  });

  // Bug #2292: retiming a shot leaves its uploaded clip current; update_shot says it stales it.
  test.fixme('a retime stales the clip, never the shot prompts', async () => {
    await call(request, 'update_shot', {
      ...s(),
      shotId: target.id,
      durationSeconds: 9,
    });
    await expectShot(target.id, {
      video: 'stale',
      thumbnail: 'fresh',
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
  });

  test('a shot can opt out of its start frame without touching its neighbours', async () => {
    await call(request, 'update_shot', {
      ...s(),
      shotId: target.id,
      useStartFrame: true,
    });
    await openShot(target);
    await page.getByRole('tab', { name: 'Video' }).click();
    const toggle = page.getByRole('checkbox', { name: 'Use start frame' });
    // Saved through a mutation; a click before hydration does nothing, so retry.
    const setToggle = (on: boolean) =>
      expect(async () => {
        if ((await toggle.isChecked()) !== on) await toggle.click();
        await expect(toggle).toBeChecked({ checked: on, timeout: 5_000 });
      }).toPass({ timeout: 30_000 });
    await expect(toggle).toBeChecked();
    await setToggle(false);

    // No still to track: the still is untracked, the clip is owed again.
    await expectShot(target.id, {
      thumbnail: 'untracked',
      visualPrompt: 'untracked',
      motionPrompt: 'stale',
    });
    await expectOthers(target.id, { motionPrompt: 'fresh' });

    await setToggle(true);
    await expectShot(target.id, {
      thumbnail: 'fresh',
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
  });

  test('adding, reordering, removing and restoring a shot leaves the others as they were', async () => {
    const rows = await readShots();
    const before = byId(rows, target.id);
    const scene = (
      await call(request, 'list_scenes', { ...s(), limit: 50 }, Scenes)
    ).scenes.find((x) => (x.title ?? '') === before.scene);
    if (!scene) throw new Error('scene not found');

    const added = await call(
      request,
      'create_shot',
      { ...s(), sceneId: scene.id },
      z.object({ shotId: z.string() })
    );
    const inScene = (await readShots()).filter((r) => r.scene === before.scene);
    expect(inScene.map((r) => r.id)).toContain(added.shotId);

    const snapshot = (all: ShotState[]) =>
      all
        .filter((r) => r.id !== added.shotId)
        .map(({ id, thumbnail, visualPrompt, motionPrompt, video, lines }) => ({
          id,
          thumbnail,
          visualPrompt,
          motionPrompt,
          video,
          lines,
        }));
    const settled = snapshot(await readShots());

    // Reorder is a hash-inert move: nothing goes stale, the lines stay put.
    await call(request, 'reorder_shots', {
      ...s(),
      sceneId: scene.id,
      shotIds: [
        added.shotId,
        ...inScene.filter((r) => r.id !== added.shotId).map((r) => r.id),
      ],
    });
    expect(snapshot(await readShots())).toEqual(settled);

    // Remove then restore: the shot returns with its lines and verdicts.
    await call(request, 'delete_shot', { ...s(), shotId: added.shotId });
    expect((await readShots()).map((r) => r.id)).not.toContain(added.shotId);
    expect(snapshot(await readShots())).toEqual(settled);
    await call(request, 'restore_shot', { ...s(), shotId: added.shotId });
    expect((await readShots()).map((r) => r.id)).toContain(added.shotId);
    expect(snapshot(await readShots())).toEqual(settled);

    // The UI agrees: the restored shot has a card in its scene.
    await page.goto(`/sequences/${sequenceId}/scenes`);
    await expect(
      sceneGroup(before.scene).getByRole('link', { name: /Shot \d+ ·/ })
    ).toHaveCount(inScene.length);
  });

  // Bug #2290: Regenerate Image rewrites scene continuity and stales the shot spec.
  test.fixme('regenerating a still leaves the shot spec current', async () => {
    await call(request, 'generate_shot_image', {
      ...s(),
      shotId: neighbour.id,
      model: 'seedream_v5',
    });
    await settleVersions('image', neighbour.frameId, 2);
    const { verdict } = await call(
      request,
      'get_shot_spec',
      { ...s(), shotId: neighbour.id },
      SpecRead
    );
    expect(verdict).toBe('current');
  });

  // Bug #2291: the visual prompt carries the spoken line, so Seedream burns it in as a caption.
  test.fixme('a still prompt does not contain the shot’s spoken line', async () => {
    await openShot(target);
    await page.getByRole('tab', { name: 'Start Frame' }).click();
    const prompt = page.getByRole('tabpanel', { name: 'Start Frame' });
    for (const line of byId(await readShots(), target.id).lines) {
      await expect(prompt).not.toContainText(line);
    }
  });
});
