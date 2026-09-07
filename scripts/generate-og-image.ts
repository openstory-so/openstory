/**
 * Regenerates the OpenGraph image (public/og.jpg) from the live front page.
 *
 * The OG card *is* the app's front page (the anonymous new-sequence composer):
 * OpenStory logo, "Tell your whole story", and the script box. Captured in dark
 * mode at 2x (2400x1260, a 1200x630 card) and served same-origin from /og.jpg,
 * so the social card always matches the product and deploys atomically with it.
 *
 * Usage: start the app (`bun dev`), then `bun scripts/generate-og-image.ts`.
 * Override the target with OG_BASE_URL (defaults to http://localhost:3000).
 */
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE_URL = process.env.OG_BASE_URL ?? 'http://localhost:3000';
const OUT = resolve(import.meta.dirname, '../public/og.jpg');
// Logical card size; the 2x deviceScaleFactor doubles the captured pixels.
const WIDTH = 1200;
const HEIGHT = 630;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

// Anonymous visitor — the front page is browsable without login, and that
// logged-out hero (logo + tagline + composer) is exactly the OG card we want.
await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: 'Tell your whole story' }).waitFor();
// Wait for the style library to load so the composer shows real style tiles
// instead of empty skeletons.
await page
  .getByRole('button', { name: /^View .+ details$/ })
  .first()
  .waitFor();
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);

// Drop the nav so the hero centers in the card instead of sitting off to the
// right behind it. The sidebar must be *removed*, not just display:none'd: the
// OpenStory logo fills from an SVG gradient (id="twilight-dark") that the
// sidebar's own logo also defines first in the DOM, and a display:none gradient
// stops painting — so the hero logo only resolves its own def once the sidebar
// node is gone. Also drop the breadcrumb header (chrome, no logo).
await page.evaluate(() => {
  document.querySelector('[data-slot="sidebar"]')?.remove();
  document.querySelector('[data-slot="sidebar-inset"] > header')?.remove();
  // Drop the "See what you can create" sample showcase below the composer so
  // it doesn't peek into the bottom of the card.
  document.querySelector('#compose ~ section')?.remove();
});
// Hide the dev-only TanStack devtools overlay (absent in prod builds). CSS wins
// over the client re-mounting the trigger.
await page.addStyleTag({
  content:
    '[data-testid="tanstack_devtools"], #tanstack_devtools { display: none !important; }',
});

await mkdir(dirname(OUT), { recursive: true });
await page.screenshot({
  path: OUT,
  type: 'jpeg',
  quality: 90,
  clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
});

await browser.close();
console.log(`Wrote ${OUT} (${WIDTH * 2}x${HEIGHT * 2})`);
