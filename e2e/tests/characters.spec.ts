/**
 * Characters page E2E (#2017, #2065): the team's characters, one character's
 * page, and deleting one no sequence casts. Nothing here generates anything.
 */

import { expect, type Page } from 'playwright/test';
import { test } from '../fixtures/auth.fixture';
import {
  cleanupSequenceById,
  createTestCharacter,
  createTestSequence,
  type TestCharacter,
  type TestSequence,
} from '../fixtures/sequence.fixture';

/** Lazy route chunk + loader on a cold dev server. */
const HYDRATION_TIMEOUT = 15_000;
const SHEET_URL = '/api/test/image?w=512&h=512&label=sheet';

let sequence: TestSequence;
let character: TestCharacter;

const card = (page: Page) =>
  page.getByRole('link', { name: character.name, exact: true });

async function openCharacterPage(page: Page) {
  await page.goto(`/characters/${character.id}`);
  await expect(
    page.getByRole('heading', { name: character.name, level: 1 })
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
}

test.describe('Characters page', () => {
  test.beforeEach(async ({ testUser }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    sequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Characters ${suffix}`
    );
    // The sheet is the pre-#1419 shape (a row keyed to the character's id,
    // no pointer).
    character = await createTestCharacter(
      sequence.id,
      'char_001',
      `Mia ${suffix}`,
      null,
      { sheetImageUrl: SHEET_URL }
    );
  });

  test.afterEach(async () => {
    await cleanupSequenceById(sequence.id, sequence.styleId);
  });

  test('lists a cast character and opens its page with the sequence that casts it', async ({
    page,
  }) => {
    await page.goto('/characters');
    await expect(card(page)).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    await card(page).click();

    await expect(page).toHaveURL(new RegExp(`/characters/${character.id}`), {
      timeout: HYDRATION_TIMEOUT,
    });
    await expect(
      page.getByRole('heading', { name: character.name, level: 1 })
    ).toBeVisible();
    const sequences = page.getByRole('navigation', {
      name: 'Sequences that cast this character',
    });
    await expect(sequences.getByText('Cast in 1 sequence')).toBeVisible();
    await expect(
      sequences.getByRole('link', { name: new RegExp(sequence.title) }).first()
    ).toHaveAttribute('aria-current', 'page');
  });

  /** "Add existing character" on `other`'s cast facet. */
  async function castIntoSecondSequence(page: Page, other: TestSequence) {
    await page.goto(`/sequences/${other.id}/scenes?facet=cast`);
    await page
      .getByRole('button', { name: 'Add existing character' })
      .click({ timeout: HYDRATION_TIMEOUT });
    const dialog = page.getByRole('dialog', { name: 'Add existing character' });
    await dialog.getByLabel('Search characters').fill(character.name);
    await dialog
      .getByRole('button', { name: new RegExp(character.name) })
      .click();
    await expect(page.getByText(`Added ${character.name}`)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('link', { name: new RegExp(character.name) }).first()
    ).toBeVisible();
  }

  test('Add existing character casts the character into a second sequence (#2050)', async ({
    page,
    testUser,
  }) => {
    const other = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Second ${crypto.randomUUID().slice(0, 8)}`
    );
    try {
      await castIntoSecondSequence(page, other);

      // One character, two sequences.
      await openCharacterPage(page);
      await expect(
        page
          .getByRole('navigation', {
            name: 'Sequences that cast this character',
          })
          .getByText('Cast in 2 sequences')
      ).toBeVisible();
    } finally {
      await cleanupSequenceById(other.id, other.styleId);
    }
  });

  test('a sequence that does not cast the character is said so, and the picker puts the right one in the URL', async ({
    page,
  }) => {
    await page.goto(
      `/characters/${character.id}?sequence=01AAAAAAAAAAAAAAAAAAAAAAAA`
    );
    await expect(
      page.getByText('Not cast in that sequence. Pick one above.')
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });

    await page
      .getByRole('navigation', { name: 'Sequences that cast this character' })
      .getByRole('link', { name: new RegExp(sequence.title) })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`sequence=${sequence.id}`));
    await expect(
      page.getByText('Not cast in that sequence. Pick one above.')
    ).toHaveCount(0);
    // The sequence's own detail view is what shows below.
    await expect(
      page.getByRole('button', { name: 'Save as talent' })
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
  });

  test('a character no sequence casts says so and can be deleted; cast, it has no Delete (#2065)', async ({
    page,
  }) => {
    const deleteButton = page.getByRole('button', {
      name: 'Delete',
      exact: true,
    });
    await openCharacterPage(page);
    await expect(deleteButton).toHaveCount(0);

    // Remove it from its only sequence (a soft remove, with a confirm).
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/sequences/${sequence.id}`), {
      timeout: HYDRATION_TIMEOUT,
    });

    await openCharacterPage(page);
    // The same page with no sequence (#2017): its sheet and voice are its
    // own, and nothing of a sequence's (Remove) is offered.
    await expect(
      page.getByRole('button', { name: 'Generate Sheet' })
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    await expect(page.getByRole('switch', { name: 'Voice' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove', exact: true })
    ).toHaveCount(0);

    // Still listed: nothing has to hold a character.
    await page.goto('/characters');
    await expect(card(page)).toBeVisible({ timeout: HYDRATION_TIMEOUT });

    await openCharacterPage(page);
    await deleteButton.click();
    await page
      .getByRole('alertdialog', { name: `Delete ${character.name}?` })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page.getByText(`Deleted ${character.name}`)).toBeVisible();
    await expect(page).toHaveURL(/\/characters$/);
    await expect(card(page)).toHaveCount(0);

    await page.goto(`/characters/${character.id}`);
    await expect(
      page.getByRole('heading', { name: 'Character not found' })
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
  });

  test('New character makes one with no sequence; its bible and looks are edited on its page (#2065)', async ({
    page,
  }) => {
    const name = `Zed ${crypto.randomUUID().slice(0, 8)}`;
    await page.goto('/characters');
    await page.getByRole('button', { name: 'New character' }).click();
    const dialog = page.getByRole('dialog', { name: 'New character' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    await expect(page).toHaveURL(/\/characters\/[0-9A-Z]{26}$/);
    await expect(
      page.getByRole('button', { name: 'Generate Sheet' })
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });

    // The bible, with no sequence to pin it.
    await page.getByRole('textbox', { name: 'Age' }).fill('36');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Character saved')).toBeVisible();

    // A second look, then removed again.
    const looks = page.getByRole('radiogroup', { name: 'Looks' });
    await page.getByRole('button', { name: 'Add look' }).click();
    const addForm = page
      .locator('form')
      .filter({ has: page.locator('#new-look-name') });
    await addForm.locator('#new-look-name').fill('Gala');
    await addForm.getByRole('button', { name: 'Add look' }).click();
    await expect(looks.getByText('Gala')).toBeVisible();
    await page.getByRole('button', { name: 'Edit look' }).click();
    await page.getByRole('button', { name: 'Remove look' }).click();
    await expect(page.getByText('Removed Gala')).toBeVisible();
    await expect(looks.getByText('Gala')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Age' })).toHaveValue('36', {
      timeout: HYDRATION_TIMEOUT,
    });

    // Listed with the team's characters, and deletable: nothing casts it.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: `Delete ${name}?` })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page.getByText(`Deleted ${name}`)).toBeVisible();
  });

  test('an unknown character is not found, with a way back', async ({
    page,
  }) => {
    await page.goto('/characters/01AAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(
      page.getByRole('heading', { name: 'Character not found' })
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    await page.getByRole('link', { name: 'Back to Characters' }).click();
    await expect(page).toHaveURL(/\/characters$/);
  });
});
