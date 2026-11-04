/**
 * Organization E2E: invite → accept → act as a member (#813).
 *
 * The stored session is the owner. A second user is created, invited from
 * Organization settings, signs in in a fresh context, joins, and is then
 * gated as a member.
 */

import { z } from 'zod';
import {
  authenticateUser,
  cleanupTestUser,
  createTestUser,
  expect,
  test,
} from '../fixtures/auth.fixture';

const invitationsSchema = z.array(
  z.object({ id: z.string(), email: z.string(), status: z.string() })
);

test.describe('Organization membership', () => {
  // Two sign-ins and three page loads do not fit the 30s default.
  test.setTimeout(120_000);

  test('owner invites, invitee joins and is gated as a member', async ({
    page,
    browser,
    testUser,
  }) => {
    const invitee = await createTestUser({ name: 'E2E Invitee' });
    try {
      await page.goto('/settings/organization');
      await page.getByLabel('Email').fill(invitee.email);
      await page.getByRole('button', { name: 'Send invitation' }).click();
      await expect(page.getByText(invitee.email)).toBeVisible();

      // The accept link is in an email; the id comes from the plugin's list.
      const listed = await page.request.get(
        '/api/auth/organization/list-invitations'
      );
      const invitation = invitationsSchema
        .parse(await listed.json())
        .find((row) => row.email === invitee.email && row.status === 'pending');
      if (!invitation) throw new Error('Invitation not listed');

      // A bare newContext inherits the owner's stored session.
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const inviteePage = await context.newPage();
      try {
        await authenticateUser(inviteePage, invitee.email);
        await inviteePage.goto(
          `/organization/accept-invitation?id=${invitation.id}`
        );
        // Disabled until hydrated; a click before that is a native GET.
        const join = inviteePage.getByRole('button', {
          name: 'Join organization',
        });
        await expect(join).toBeEnabled({ timeout: 30_000 });
        await join.click();
        await inviteePage.getByRole('link', { name: 'Continue' }).click();

        // Joined and switched: the owner is now in the member list.
        await expect(inviteePage).toHaveURL(/\/settings\/organization/);
        await expect(inviteePage.getByText(testUser.email)).toBeVisible();
        // A member cannot see or reach API keys.
        await expect(
          inviteePage.getByRole('tab', { name: 'API Keys' })
        ).toHaveCount(0);
        await inviteePage.goto('/settings/api-keys');
        await expect(inviteePage).toHaveURL(/\/settings\/organization/);
      } finally {
        await context.close();
      }

      // The owner sees the new member.
      await page.reload();
      await expect(page.getByText(invitee.email).first()).toBeVisible();
    } finally {
      await cleanupTestUser(invitee.id, invitee.organizationId);
    }
  });
});
