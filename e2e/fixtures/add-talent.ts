/**
 * Shared Add Talent dialog helpers for talent-page and sequence-page e2e.
 */

import { expect, type Locator, type Page } from 'playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  fillScriptEditor,
  waitForLibraryPageLoad,
  waitForUploadComplete,
} from './test-utils';

export const TEST_IMAGE_JPEG = readFileSync(
  path.join(import.meta.dirname, 'test-image.jpg')
);

export function uniqueTalentName(label: string): string {
  return `E2E ${label} ${crypto.randomUUID().slice(0, 8)}`;
}

export function addTalentDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Add Talent' });
}

export async function openAddTalentFromLibrary(page: Page): Promise<Locator> {
  await page.goto('/talent');
  await waitForLibraryPageLoad(page, 'Add Talent');
  await page.getByRole('button', { name: 'Add Talent' }).first().click();
  const dialog = addTalentDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openAddTalentFromSequence(page: Page): Promise<{
  picker: Locator;
  dialog: Locator;
}> {
  await page.goto('/sequences/new');
  // TipTap only mounts after hydration. Filling a short script is the same
  // live-state gate sequence-flow.spec uses — Generate-enabled is the wrong
  // proxy here. Sample seeding on signed-in `/sequences/new` is racy (styles
  // are not SSR-prefetched), and a tile click does not write a script unless
  // the sample is already attached, so Generate can stay disabled forever.
  await fillScriptEditor(
    page,
    'INT. STUDIO - DAY\n\nA person looks at the camera.'
  );
  await page.locator('main').getByRole('button', { name: 'Talent' }).click();
  // DialogTitle is not always the accessible name; match on the heading copy.
  const picker = page
    .getByRole('dialog')
    .filter({ hasText: 'Select Talent for Casting' });
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await picker.getByRole('button', { name: 'Add Talent' }).last().click();
  const dialog = addTalentDialog(page);
  await expect(dialog).toBeVisible();
  return { picker, dialog };
}

export async function uploadNamedTalentImage(
  page: Page,
  filename: string
): Promise<void> {
  const dialog = addTalentDialog(page);
  const fileChooserPromise = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Browse files' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: filename,
    mimeType: 'image/jpeg',
    buffer: TEST_IMAGE_JPEG,
  });
  await waitForUploadComplete(page);
}

// Drag-and-drop path (vs. the file chooser above): the dialog is a portal, so
// the drop also bubbles to the composer's whole-page element dropzone (#1269).
export async function dropNamedTalentImage(
  page: Page,
  filename: string
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'image/jpeg' }));
      return dt;
    },
    { b64: TEST_IMAGE_JPEG.toString('base64'), name: filename }
  );
  await addTalentDialog(page)
    .getByText('Drag & drop or paste')
    .dispatchEvent('drop', { dataTransfer });
  await waitForUploadComplete(page);
}

export async function waitForSubjectKind(
  page: Page,
  kind: 'Human' | 'Animated' | 'Other'
): Promise<Locator> {
  const radio = addTalentDialog(page).getByRole('radio', { name: kind });
  await expect(radio).toBeVisible({ timeout: 15_000 });
  await expect(radio).toBeChecked();
  return radio;
}

export async function attestPortraitRights(page: Page): Promise<void> {
  const dialog = addTalentDialog(page);
  await dialog
    .getByRole('checkbox', { name: /authorization to use this person/i })
    .check();
  await dialog
    .getByLabel('Basis for authorization')
    .fill('E2E fixture image — synthetic, depicts no real person');
}

export async function attestAssetRights(page: Page): Promise<void> {
  await addTalentDialog(page)
    .getByRole('checkbox', { name: /hold the rights to this asset/i })
    .check();
}

export async function submitAddTalent(page: Page): Promise<void> {
  const dialog = addTalentDialog(page);
  await dialog.getByRole('button', { name: 'Add Talent' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
}
