/**
 * Full Sequence Pipeline E2E Test
 *
 * Drives the complete sequence creation flow with real workflows running on
 * Cloudflare Workflows (in-process in Workerd via the @cloudflare/vite-plugin),
 * and AI traffic served by aimock (LLM via OpenRouter passthrough, fal.ai via
 * the mounted fal handler).
 *
 * This spec only runs when `PLAYWRIGHT_FULL_PIPELINE=true` is set. Use
 * `bun test:e2e:full` to invoke it. CI runs it in the dedicated
 * `e2e-full-pipeline` job in `.github/workflows/test.yml`.
 *
 * Prerequisites:
 * - Recorded fixtures in `e2e/fixtures/recorded/` (run
 *   `bun test:e2e:record:full` once with real FAL_KEY + OPENROUTER_API_KEY in
 *   .env.local to populate; new openrouter recordings sort into stage
 *   subfolders automatically on aimock teardown).
 */

import { resolve } from 'node:path';
import { expect, type Locator } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import {
  getSystemLocationByName,
  type TestLibraryLocation,
} from '../fixtures/location.fixture';
import {
  cleanupSequenceById,
  createTestStyle,
  getTestSequenceShots,
  getTestSequenceStatus,
} from '../fixtures/sequence.fixture';
import {
  getSystemTalentByName,
  type TestTalent,
} from '../fixtures/talent.fixture';
import {
  fillScriptEditor,
  pinRecordedPipelineSettings,
  selectComposerStyle,
  selectRecordedPipelineModels,
} from '../fixtures/test-utils';
import { t } from '../recording-mode';

const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';

/**
 * Assert that a <video> / <audio> element has decoded enough metadata to be
 * playable: the URL resolves, the container is decodable, and a duration is
 * known. `readyState >= 1` (HAVE_METADATA) is sufficient — we deliberately
 * don't call `.play()` because autoplay is unreliable in headless Chromium
 * and tells us nothing extra about whether the resource itself is healthy.
 */
const expectPlayableMedia = async (locator: Locator, label: string) => {
  await expect(locator, `${label}: element visible`).toBeVisible({
    timeout: t(60_000),
  });
  await expect
    .poll(
      async () =>
        locator.evaluate(
          (el: HTMLMediaElement) =>
            el.readyState >= 1 &&
            Number.isFinite(el.duration) &&
            el.duration > 0
        ),
      {
        message: `${label}: readyState>=1 and duration>0`,
        timeout: t(60_000),
        intervals: [500, 1_000, 2_000],
      }
    )
    .toBe(true);
};

/**
 * Assert the shared player is playing *this* scene's video, and return the
 * source it settled on.
 *
 * The `<video>` element persists across scene selection — only its `src`
 * changes — so a plain readyState check is satisfied instantly by the previous
 * scene's already-loaded metadata, and a scene with a broken video passes
 * green. Requiring the source to differ from the one we last asserted ties each
 * iteration to the scene it names.
 */
const expectSceneVideoPlayable = async (
  locator: Locator,
  previousSrc: string,
  label: string
): Promise<string> => {
  await expect(locator, `${label}: element visible`).toBeVisible({
    timeout: t(60_000),
  });
  await expect
    .poll(
      async () =>
        locator.evaluate(
          (el: HTMLMediaElement, prev) =>
            Boolean(el.currentSrc) &&
            el.currentSrc !== prev &&
            el.readyState >= 1 &&
            Number.isFinite(el.duration) &&
            el.duration > 0,
          previousSrc
        ),
      {
        message: `${label}: switched to its own source, readyState>=1, duration>0`,
        timeout: t(60_000),
        intervals: [500, 1_000, 2_000],
      }
    )
    .toBe(true);
  return locator.evaluate((el: HTMLMediaElement) => el.currentSrc);
};

testWithUser.describe('Full Sequence Pipeline', () => {
  testWithUser.skip(
    !fullPipeline,
    'Set PLAYWRIGHT_FULL_PIPELINE=true (use `bun test:e2e:full`) to run.'
  );

  // The full pipeline runs many workflow steps end-to-end (script → shots →
  // auto motion → music under product defaults #1140). Each per-step poll
  // below allows up to 10 minutes; the outer cap accommodates all three
  // running near their limit plus setup.
  testWithUser.setTimeout(1_800_000);

  let testTalents: TestTalent[] = [];
  let testLocation: TestLibraryLocation | null = null;
  let styleId: string | null = null;
  let createdSequenceId: string | null = null;

  testWithUser.beforeEach(async ({ testUser }) => {
    // Pull seeded system talent + locations rather than fabricating ones
    // with placeholder URLs — workflows need real R2 reference images for
    // character/location matching and sheet rendering. The seed runs in
    // e2e/start-webserver.ts before Workerd starts.
    testTalents = [
      await getSystemTalentByName('Sienna Blake'),
      await getSystemTalentByName('Jude Calloway'),
    ];
    testLocation = await getSystemLocationByName('Sunlit Loft Studio');
    styleId = await createTestStyle(testUser.teamId);
  });

  testWithUser.afterEach(async () => {
    if (createdSequenceId && styleId) {
      await cleanupSequenceById(createdSequenceId, styleId);
    }
    // System talent and locations are shared and seeded — never delete them.
    testTalents = [];
    testLocation = null;
    styleId = null;
    createdSequenceId = null;
  });

  testWithUser(
    'creates a sequence and runs every workflow through to motion + music',
    async ({ page }) => {
      // Capture browser-side errors that would otherwise be invisible:
      // uncaught exceptions, console.error/warn from app code, failed network
      // requests, and 5xx responses. Filters two well-understood sources of
      // noise so the signal isn't drowned:
      //   - `net::ERR_ABORTED` requestfailed: in-flight requests cancelled by
      //     navigation/unmount (img tags, SSE streams, server functions).
      //     Normal lifecycle, not a bug.
      //   - TanStack Devtools' `%cLOG%c` console wrapper: decorates real logs
      //     with a "Go to Source" link and re-emits as console.error. The
      //     underlying log is what matters; the wrapping is not an app error.
      const browserErrors: string[] = [];
      page.on('pageerror', (err) => {
        browserErrors.push(`pageerror: ${err.message}`);
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error' && msg.type() !== 'warning') return;
        const text = msg.text();
        if (text.startsWith('%cLOG%c')) return;
        // Chrome auto-emits "Failed to load resource: <errorText>" alongside
        // every `requestfailed` event — same incident, second copy. The
        // requestfailed handler below already records non-aborted failures.
        if (text.startsWith('Failed to load resource:')) return;
        browserErrors.push(`console.${msg.type()}: ${text}`);
      });
      page.on('requestfailed', (req) => {
        const errorText = req.failure()?.errorText ?? 'unknown';
        if (errorText === 'net::ERR_ABORTED') return;
        browserErrors.push(
          `requestfailed: ${req.method()} ${req.url()} — ${errorText}`
        );
      });
      page.on('response', (res) => {
        if (res.status() >= 500) {
          browserErrors.push(
            `http ${res.status()}: ${res.request().method()} ${res.url()}`
          );
        }
      });

      // 1. Open the new-sequence page. Pin Quality + recorded Grok/Seedance
      // before first paint so Turbo (Lite / H3 Max) never hits aimock.
      await pinRecordedPipelineSettings(page);
      await page.goto('/sequences/new');

      // 2. Recorded image/motion fixtures were captured against Product Ad.
      // The composer now defaults to Film & Cinematic (#1180), so switch
      // the row and pick that style by name — clicking `.first()` would
      // land on Action and miss every fal fixture.
      await selectComposerStyle(page, 'Product Ad', 'E-commerce');

      // 3. Type a short script — a 30-second makeup ad. City, not beach:
      // Grok Imagine Quality's checker rejects swimwear, so a Bondi/surf
      // brief dies at still generation even when enhance is fine.
      const script = `
CORAL — A CITY LAUNCH

INT. DOWNTOWN APARTMENT BATHROOM - MORNING

Hard light off white tile. SCARLETT,
a city influencer in a black turtleneck,
unboxes a coral lipstick and turns it slowly to camera.

SCARLETT (V.O.)
One shade. One city.

CLOSE ON THE TUBE — the coral bullet twists up and catches the
light. Scarlett smiles at her reflection, the colour already hers.

EXT. DOWNTOWN SIDEWALK - CONTINUOUS

Scarlett walks a crowded crosswalk, taxis stacked at the light,
office glass behind her. She glances back at camera.

SCARLETT (V.O.)
Made for the street. Wear it everywhere.

EXT. ROOFTOP LEDGE - CONTINUOUS

She laughs as a train rattles past below. The lipstick lands
beside the brand mark on the concrete ledge.

SUPER:  CORAL.  OUT NOW.
      `.trim();
      await fillScriptEditor(page, script);

      // 4. Enhance script (LLM streaming via aimock OpenRouter passthrough).
      await expect(
        page.getByRole('button', { name: /Enhance Script/i })
      ).toBeEnabled({ timeout: 10_000 });
      await page.getByRole('button', { name: /Enhance Script/i }).click();
      await expect(page.getByText('Target video duration')).toBeVisible();
      // Pick 1m so the enhancer generates more scenes (default is 30s). The
      // duration toggle is a Radix ToggleGroup type="single"; its items render
      // with role="radio".
      await page.getByRole('radio', { name: '1m' }).click();
      await page.getByRole('button', { name: 'Enhance' }).last().click();
      await expect(page.getByRole('button', { name: /Stop/i })).toBeVisible({
        timeout: t(15_000),
      });
      await expect(page.getByRole('button', { name: /Stop/i })).not.toBeVisible(
        { timeout: t(60_000) }
      );

      // 5. Pick talent.
      await page
        .locator('main')
        .getByRole('button', { name: 'Talent' })
        .click();
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible({ timeout: 10_000 });
      const firstTalent = testTalents[0];
      if (!firstTalent) {
        throw new Error('test setup: expected at least one test talent');
      }
      await page.getByText(firstTalent.name).click();
      await page.getByRole('button', { name: 'Cast 1 role' }).click();
      await expect(talentDialog).not.toBeVisible();

      // 6. Pick location.
      await page
        .locator('main')
        .getByRole('button', { name: 'Locations' })
        .click();
      const locationDialog = page.getByRole('dialog');
      await expect(locationDialog).toBeVisible({ timeout: 10_000 });
      if (!testLocation) throw new Error('testLocation not initialised');
      await page.getByText(testLocation.name).click();
      await page.getByRole('button', { name: 'Use 1 location' }).click();
      await expect(locationDialog).not.toBeVisible();

      // 7. Upload an element image directly to the file input on the page.
      // Photo by Vidak on Unsplash: https://unsplash.com/photos/KiqrvOpdv0I
      const fileInput = page.locator('input[type="file"][accept*="image"]');
      await fileInput.setInputFiles(
        resolve(import.meta.dirname, '../fixtures/broadcast-mic.jpg')
      );

      // 7b. Quality + Grok Imagine 2.0 + Seedance 2.0. Style apply can
      // remap recommendations; the recorded fal folders are those two
      // endpoints (Grok 2.0 edit/t2i, Seedance 2.0 r2v). Turbo's Lite /
      // H3 Max have no recordings.
      await selectRecordedPipelineModels(page);

      // 8. Generate — should kick off the workflow chain and navigate.
      // Vision analysis (analyzeDraftElementFn) is the long pole here; it can
      // take ~15-20s when aimock falls back to upstream, so give it headroom.
      await expect(
        page.getByRole('button', { name: /^Generate$/i })
      ).toBeEnabled({ timeout: t(30_000) });
      await page.getByRole('button', { name: /^Generate$/i }).click();
      // Generate kicks off the scene-split workflow before the redirect lands.
      await page.waitForURL(/\/sequences\/[^/]+\/scenes/, {
        timeout: t(30_000),
      });
      const match = page.url().match(/\/sequences\/([^/]+)\/scenes/);
      const sequenceId = match?.[1];
      if (!sequenceId) {
        throw new Error(`Failed to extract sequence id from ${page.url()}`);
      }
      createdSequenceId = sequenceId;

      // Progressive reveal (#1091): analysis lands on the forced script view —
      // the canvas has nothing to show until the first shot preview arrives.
      // Assert immediately after the redirect, before any preview can land
      // and auto-reveal the canvas.
      //
      // The toggle itself only exists post-hydration, so wait for it to render
      // before reading `data-state` — on the bare 5s expect timeout the
      // assertion could fail because the control had not mounted yet, which
      // looks identical to the view being wrong.
      const scriptToggle = page.getByRole('radio', { name: 'Show the script' });
      await expect(scriptToggle).toBeVisible({ timeout: t(15_000) });
      await expect(scriptToggle).toHaveAttribute('data-state', 'on');

      // 9. Wait for storyboard + shot images to land in the DB.
      //
      // Content-flag retry coverage (#881): two recorded fixtures inject a
      // first-attempt content-checker 422 (sequenceIndex 0) then succeed —
      //   - image: nano-banana-2-edit "Cinematic realistic still of SCARLETT…"
      //   - video: grok "Handheld camera tracks forward…"
      // so the vanity scene's primary image and that clip's video each fail
      // once and are rescued by the workflow retry (image: CF default step
      // retry; motion: submit→poll loop). The "every shot completed" /
      // "every shot has video" assertions below therefore also prove the
      // retry path end-to-end — no separate spec needed.
      await expect
        .poll(
          async () => {
            const shots = await getTestSequenceShots(sequenceId);
            if (shots.length === 0) return false;
            return shots.every((f) => f.thumbnailStatus === 'completed');
          },
          { timeout: 600_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBe(true);

      // 10. Wait for auto motion + music to finish. Product defaults (#1140)
      //     turn autoGenerateMotion + autoGenerateMusic ON, so Generate
      //     already chains storyboard → motion batch → music — there is no
      //     "Generate N / M shots" footer when every shot is already
      //     generating or complete. Poll the DB only; the batch button is
      //     for the manual (motion-off) path, not this aha flow.
      await expect
        .poll(
          async () => {
            const shots = await getTestSequenceShots(sequenceId);
            if (shots.length === 0) return false;
            const videosDone = shots.every(
              (f) => f.videoStatus === 'completed' && !!f.videoUrl
            );
            if (!videosDone) return false;
            const status = await getTestSequenceStatus(sequenceId);
            return status?.musicStatus === 'completed' && !!status.musicUrl;
          },
          { timeout: t(600_000), intervals: [2_000, 5_000, 10_000] }
        )
        .toBe(true);

      // 11. Per-scene playback: click through every scene-list-item and
      //     assert the active <video> in the ScenePlayer is decodable.
      //     The list item carries `data-testid="scene-list-item"` so we can
      //     enumerate without relying on title text. Shots are nested under
      //     scene-group headers after stream-time scene persistence (#1072).
      //
      //     The player only shows the scene's <video> on a video tab; the
      //     default "Variants" tab (the multi-model scene-review UX, #545)
      //     shows the still image instead — leaving the only <video> in the
      //     DOM the hidden next-scene prefetch (`<video preload="auto">`).
      //     Select the Video tab once (it persists across scene selection) so
      //     each scene's player renders its <video>; that player video is
      //     ordered before the prefetch in the DOM, so `.first()` resolves to
      //     it.
      // Progressive reveal (#1091): the first preview auto-revealed the canvas
      // (no explicit view in the URL), so by now the toggle is enabled AND the
      // canvas is the active view — the playback checks below depend on it.
      const canvasToggle = page.getByRole('radio', {
        name: 'Show the canvas',
      });
      await expect(canvasToggle).toBeEnabled();
      await expect(canvasToggle).toHaveAttribute('data-state', 'on');

      const sceneItems = page.locator('[data-testid="scene-list-item"]');
      const sceneCount = await sceneItems.count();
      expect(sceneCount, 'sequence has at least one scene').toBeGreaterThan(0);
      await sceneItems.first().click();
      await page.getByRole('tab', { name: 'Video' }).click();
      // Scope to visible videos: the hidden next-scene prefetch is a <video>
      // too, and while the player swaps scenes its own element can drop out of
      // the DOM, so a bare `video` locator resolves to the prefetch.
      const playerVideo = page.locator('video:visible').first();
      let assertedSrc = '';
      for (let i = 0; i < sceneCount; i++) {
        await sceneItems.nth(i).click();
        assertedSrc = await expectSceneVideoPlayable(
          playerVideo,
          assertedSrc,
          `scene ${i + 1} video`
        );
      }

      // 12. Music playback in the Scenes editor Music facet (#986).
      await page.goto(`/sequences/${sequenceId}/scenes?facet=music`);
      await expectPlayableMedia(
        page.locator('audio').first(),
        'sequence music'
      );

      // 13. Whole-sequence playback in the Scenes canvas (#986) — nothing
      //     selected uses SequencePlayer (mediabunny → <canvas>). Play only
      //     mounts after prepare() resolves.
      await page.goto(`/sequences/${sequenceId}/scenes`);

      // Wait for either the Play button (success) or the player error state.
      // A hanging prepare() (common with raw AI-generated motion clips during
      // fresh recording) will still hit the outer timeout, but at least an
      // actual rejection from SequencePlayerEngine.prepare() will now fail
      // fast with the real error message instead of a useless "Play button not
      // found after 10 minutes".
      await expect
        .poll(
          async () => {
            const errorBox = page.getByTestId('player-error');
            if ((await errorBox.count()) > 0) {
              const msg = ((await errorBox.textContent()) || '').trim();
              throw new Error(
                `Theatre player failed to initialize: ${msg || '(no message)'}`
              );
            }
            const playBtn = page.getByRole('button', { name: 'Play' });
            return await playBtn.isVisible();
          },
          {
            timeout: t(60_000),
            message:
              'theatre: Play button visible (player initialized) or player errored',
          }
        )
        .toBe(true);

      // 14. Thin DB sanity tail: a UI bug that silently hides a player
      //     mustn't make the test pass green. We've already proved every
      //     resource decodes above, so the URL-presence asserts are
      //     belt-and-braces only. The "merged video" concept is gone —
      //     final composition happens client-side via Mediabunny.
      const finalStatus = await getTestSequenceStatus(sequenceId);
      expect(finalStatus?.musicUrl, 'sequence missing music url').toBeTruthy();
      const finalShots = await getTestSequenceShots(sequenceId);
      for (const shot of finalShots) {
        expect(shot.videoUrl, `shot ${shot.id} missing video`).toBeTruthy();
      }

      // Log any captured browser issues so they're visible in stdout / the
      // HTML report, but don't fail the test on them. Driving this list to
      // literal zero is impractical (h3 wraps any non-HTTPError throw as
      // unhandled, dev-only Better Auth warnings, etc.) and the listener has
      // already done its job — flushing out the real bugs we cared about
      // (hydration mismatch, missing fal proxy on createFalClient, swallowed
      // QStash failResponses). Re-enable the assertion if you want to gate
      // landings on browser cleanliness.
      if (browserErrors.length > 0) {
        const summary = browserErrors.join('\n');
        console.warn(
          `[e2e] captured ${browserErrors.length} browser issues (non-fatal):\n${summary}`
        );
      }
    }
  );
});
