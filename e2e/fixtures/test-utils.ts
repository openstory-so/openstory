/**
 * Shared test utilities for E2E tests
 * Contains common patterns for page loading and cleanup operations
 */

import type { Locator, Page } from 'playwright/test';
import { expect } from 'playwright/test';

/**
 * Budget for "this element only exists once the client has hydrated".
 * The 5s default `expect` timeout is sized for elements that are already in the
 * SSR markup; under `vite dev` with parallel workers, first-hit hydration of a
 * heavy client chunk routinely takes longer than that.
 */
const HYDRATION_TIMEOUT = 15_000;

/**
 * Resolve the composer's script input once it is actually usable.
 *
 * The wrapper is server-rendered but the TipTap editor sets
 * `immediatelyRender: false`, so `.ProseMirror` appears only after the client
 * editor initialises — this is a hydration gate, not a plain visibility check,
 * and asserting it on the default 5s timeout flakes (#827).
 */
export async function waitForScriptEditor(page: Page): Promise<Locator> {
  const editor = page.locator('[data-slot="markdown-editor"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: HYDRATION_TIMEOUT });
  return editor;
}

/**
 * Replace the composer script with `script`.
 *
 * Do not use Playwright `.fill()` here. That does DOM `selectNodeContents`
 * plus CDP `insertText`, which races ProseMirror's caret and can leave the
 * style sample in React state — the enhance request then misses the recorded
 * fixture and Stop hangs. TipTap's Mod-a is ProseMirror `AllSelection`, so
 * the newline `beforeinput` handler deletes the whole doc first.
 */
export async function fillScriptEditor(
  page: Page,
  script: string
): Promise<Locator> {
  const editor = await waitForScriptEditor(page);
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(script);
  const firstLine =
    script.split('\n').find((line) => line.trim().length > 0) ?? script;
  await expect(editor).toContainText(firstLine, { timeout: 5_000 });
  // React state (what enhance sends) lives on the wrapper. innerText can
  // still show SHORELINE when the sample was prepended.
  await expect(page.locator('[data-slot="markdown-editor"]')).toHaveAttribute(
    'data-markdown',
    script,
    { timeout: 5_000 }
  );
  // React error boundaries swallow pageerror, so a throw during the
  // composer's cost estimate (#1354) replaces the tree instead of failing
  // the test. The heading is the error-boundary copy in __root.tsx.
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' })
  ).toHaveCount(0);
  return editor;
}

/**
 * Pick a named style on the composer strip.
 *
 * The row defaults to Film & Cinematic (#1180). Styles in another family
 * need the category dropdown first — `family` is the radio label
 * (e.g. "E-commerce").
 */
export async function selectComposerStyle(
  page: Page,
  styleName: string,
  family?: string
): Promise<void> {
  if (family) {
    await page.getByRole('button', { name: /^Style category:/ }).click();
    await page.getByRole('menuitemradio', { name: family }).click();
  }
  // A selected tile relabels to "View <name> details" and clicking it opens
  // the style dialog (#1187). The bare composer defaults to Automatic (#1255);
  // category switches still pick the family's first style. So the target may
  // already be selected: only click while it still offers Select.
  const grid = page.getByRole('grid', { name: 'Style selection' });
  const tile = grid.getByRole('button', { name: `Select ${styleName} style` });
  const selectedTile = grid.getByRole('button', {
    name: `View ${styleName} details`,
  });
  await expect(tile.or(selectedTile)).toBeVisible({
    timeout: HYDRATION_TIMEOUT,
  });
  if (await tile.isVisible()) {
    await tile.click();
  }
  await expect(selectedTile).toBeVisible();
}

/**
 * Wait until every file picked in an add/edit dialog has finished uploading.
 *
 * Order matters. The submit button is only disabled while
 * `files.length > uploadedUrls.length`, and both are empty until React commits
 * the picked file — so waiting on the button alone passes instantly, before the
 * upload even starts, and the form submits with no media (#827). Waiting for
 * the file row first pins `files.length >= 1`, which makes the subsequent
 * enabled-check a genuine "uploadedUrls caught up" signal.
 */
export async function waitForUploadComplete(
  page: Page,
  submitName = 'Add Talent'
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: submitName });
  await expect(
    dialog.locator('[data-slot="file-upload-item"]').first()
  ).toBeVisible();
  // Scope to the open dialog: the page header still has an enabled
  // "Add Talent" trigger, and during the PUT the dialog submit is
  // relabeled "Uploading…". Waiting for the dialog's own submit name
  // is what actually means the file landed.
  await expect(dialog.getByRole('button', { name: submitName })).toBeEnabled({
    timeout: 15_000,
  });
}

/**
 * Wait for a library page to be hydrated by checking that its Add button is enabled.
 * The button is disabled during SSR/hydration via useHydrated hook.
 */
export async function waitForLibraryPageLoad(
  page: Page,
  buttonName: string
): Promise<void> {
  const addButton = page.getByRole('button', { name: buttonName }).first();
  await expect(addButton).toBeEnabled({ timeout: 30000 });
}

/** URL shapes that only the library *detail* routes can produce. */
export const LOCATION_DETAIL_URL = /\/locations\/[^/?#]+/;
export const TALENT_DETAIL_URL = /\/talent\/[^/?#]+/;

/**
 * Click a library card and wait for its detail route to take over.
 *
 * Gate on the URL, not the heading: the card itself renders the entity name in
 * an `<h3>`, so `getByRole('heading', { name })` also matches on the list page
 * and passes even when the click never navigated. That false positive is what
 * made #827 surface as an unrelated-looking miss on a detail-only element
 * several assertions later.
 */
export async function openLibraryCard(
  page: Page,
  name: string,
  detailUrl: RegExp
): Promise<void> {
  await page.getByText(name).click();
  // Lazy route chunk + loader, so this is a hydration-class wait too.
  await expect(page).toHaveURL(detailUrl, { timeout: HYDRATION_TIMEOUT });
}

/** Follow a "Back to …" link and wait for the list route to take over. */
export async function returnToLibraryList(
  page: Page,
  linkName: string,
  listUrl: RegExp
): Promise<void> {
  await page.getByRole('link', { name: linkName }).click();
  await expect(page).toHaveURL(listUrl, { timeout: HYDRATION_TIMEOUT });
}

/**
 * Find and cleanup a location created during a test by name.
 * Use for tests that create entities via UI and need inline cleanup.
 */
export async function cleanupLocationByName(
  teamId: string,
  name: string
): Promise<void> {
  await fetch('http://localhost:3001/api/test/location', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });
}

/**
 * Find and cleanup a talent created during a test by name.
 * Use for tests that create entities via UI and need inline cleanup.
 */
export async function cleanupTalentByName(
  teamId: string,
  name: string
): Promise<void> {
  await fetch('http://localhost:3001/api/test/talent', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });
}
