/**
 * Characters page E2E (#2017): the team's characters, the library flag, and
 * one character's page. Nothing here generates anything.
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

let sequence: TestSequence;
let character: TestCharacter;

const addButton = (page: Page) =>
  page.getByRole('button', { name: 'Add to Library', exact: true });
const removeButton = (page: Page) =>
  page.getByRole('button', { name: 'Remove from Library', exact: true });
const card = (page: Page) =>
  page.getByRole('link', { name: character.name, exact: true });

/** Undo from one toast: several can be up at once. */
const undo = (page: Page, toast: string) =>
  page
    .getByRole('listitem')
    .filter({ hasText: toast })
    .getByRole('button', { name: 'Undo' })
    .click();

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
    character = await createTestCharacter(
      sequence.id,
      'char_001',
      `Mia ${suffix}`
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

  test('Add to Library sets the flag, the Library filter shows it, Undo and Remove clear it', async ({
    page,
  }) => {
    await openCharacterPage(page);
    await addButton(page).click();
    await expect(page.getByText('Added to Library')).toBeVisible();
    await expect(removeButton(page)).toBeVisible();

    await page.goto('/characters?tab=characters&show=library');
    await expect(card(page)).toBeVisible({ timeout: HYDRATION_TIMEOUT });

    // Remove, then take it back from the toast.
    await openCharacterPage(page);
    await removeButton(page).click();
    await expect(page.getByText('Removed from Library')).toBeVisible();
    await expect(addButton(page)).toBeVisible();
    await undo(page, 'Removed from Library');
    await expect(removeButton(page)).toBeVisible();

    // Remove for good: it leaves the Library filter and stays under All.
    await removeButton(page).click();
    await expect(addButton(page)).toBeVisible();
    await page.goto('/characters?tab=characters&show=library');
    await expect(
      page.getByRole('button', { name: 'Library', exact: true })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: HYDRATION_TIMEOUT });
    await expect(card(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'All Characters' }).click();
    await expect(page).toHaveURL(/show=all/);
    await expect(card(page)).toBeVisible();
  });

  /** Library flag on, then "Add from library" on `other`'s cast facet. */
  async function castIntoSecondSequence(page: Page, other: TestSequence) {
    await openCharacterPage(page);
    await addButton(page).click();
    await expect(removeButton(page)).toBeVisible();

    await page.goto(`/sequences/${other.id}/scenes?facet=cast`);
    await page
      .getByRole('button', { name: 'Add from library' })
      .click({ timeout: HYDRATION_TIMEOUT });
    const dialog = page.getByRole('dialog', { name: 'Add from library' });
    await dialog.getByLabel('Search the library').fill(character.name);
    await dialog
      .getByRole('button', { name: new RegExp(character.name) })
      .click();
    await expect(page.getByText(`Added ${character.name}`)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('link', { name: new RegExp(character.name) }).first()
    ).toBeVisible();
  }

  test('Add from library casts the character into a second sequence (#2050)', async ({
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

  test('an edit from one sequence leaves the other on its pinned version until Update this sequence (#2017)', async ({
    page,
    testUser,
  }) => {
    // Two sequences' worth of page loads on a dev server.
    test.slow();
    const other = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Second ${crypto.randomUUID().slice(0, 8)}`
    );
    try {
      await castIntoSecondSequence(page, other);

      // Edit the character from the second sequence: the first keeps the
      // version it pinned and says so, until it is updated.
      await page.goto(`/sequences/${other.id}/cast/${character.id}`);
      const age = page.getByRole('textbox', { name: 'Age' });
      await expect(age).toBeEditable({ timeout: HYDRATION_TIMEOUT });
      const before = await age.inputValue();
      await age.fill('40s');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Character saved')).toBeVisible();

      await page.goto(`/sequences/${sequence.id}/cast/${character.id}`);
      await expect(
        page.getByText(`${character.name} is not on the current version here`, {
          exact: false,
        })
      ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
      await expect(page.getByRole('textbox', { name: 'Age' })).toHaveValue(
        before,
        { timeout: HYDRATION_TIMEOUT }
      );
      // The move preview is the dialog's own, opened and closed, nothing moved.
      await page
        .getByRole('button', { name: 'Move other sequences…' })
        .click({ timeout: HYDRATION_TIMEOUT });
      const moveDialog = page.getByRole('alertdialog');
      await expect(
        moveDialog.getByRole('checkbox', { name: new RegExp(sequence.title) })
      ).toBeChecked();
      await moveDialog.getByRole('button', { name: 'Cancel' }).click();
      // Update this sequence: a pointer write, so the age follows.
      await page.getByRole('button', { name: /^Update this sequence/ }).click();
      await expect(page.getByRole('textbox', { name: 'Age' })).toHaveValue(
        '40s'
      );
      await expect(
        page.getByRole('button', { name: /^Update this sequence/ })
      ).toHaveCount(0);
    } finally {
      await cleanupSequenceById(other.id, other.styleId);
    }
  });

  test('the sequence cast page and the character page toggle the same flag', async ({
    page,
  }) => {
    await page.goto(`/sequences/${sequence.id}/cast/${character.id}`);
    await expect(addButton(page)).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    // The old copy is still offered, under its own name.
    await expect(
      page.getByRole('button', { name: 'Save as talent' })
    ).toBeVisible();
    await addButton(page).click();
    await expect(removeButton(page)).toBeVisible();

    await openCharacterPage(page);
    await expect(removeButton(page)).toBeVisible();
    await removeButton(page).click();
    await expect(addButton(page)).toBeVisible();

    await page.goto(`/sequences/${sequence.id}/cast/${character.id}`);
    await expect(addButton(page)).toBeVisible({ timeout: HYDRATION_TIMEOUT });
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

  test('a library character no sequence casts says so; out of the library it is not found, and Undo brings it back', async ({
    page,
  }) => {
    await openCharacterPage(page);
    await addButton(page).click();
    await expect(removeButton(page)).toBeVisible();

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
    await expect(page.getByText('Not cast in a sequence.')).toBeVisible();
    await expect(
      page.getByText(
        'Looks, sheets, voice and edits need a sequence that casts this character.'
      )
    ).toBeVisible();

    // The library was the last thing holding it.
    await removeButton(page).click();
    await expect(
      page.getByRole('heading', { name: 'Character not found' })
    ).toBeVisible();
    await undo(page, 'Removed from Library');
    await expect(
      page.getByRole('heading', { name: character.name, level: 1 })
    ).toBeVisible();
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
