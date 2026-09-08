import { grantWelcomeCreditsForTeam } from '@/lib/billing/checkout';
import {
  grantSignupCredits,
  shouldOfferWelcomeClaim,
  SIGNUP_GRANT_MICROS,
  welcomeDialogMode,
} from '@/lib/billing/constants';
import type { Database } from '@/lib/db/client';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateId } from '@/shared/id';
import { isWelcomeCardAlreadyClaimedError } from '@/shared/errors';
import {
  credits,
  teams,
  transactions,
  user,
  welcomeCardClaims,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBillingMethods } from '@/lib/db/scoped/billing';

describe('welcomeDialogMode', () => {
  it('asks for a card when Stripe is on and the welcome grant is still unpaid', () => {
    expect(
      welcomeDialogMode({
        stripeEnabled: true,
        hasSignupGrant: false,
        hasUsedCredits: false,
        hasOtherCredits: false,
      })
    ).toBe('claim');
  });

  it('hides the claim dialog once the grant has landed', () => {
    expect(
      welcomeDialogMode({
        stripeEnabled: true,
        hasSignupGrant: true,
        hasUsedCredits: false,
        hasOtherCredits: false,
      })
    ).toBe('none');
  });

  it('keeps the unused-gift dialog when Stripe is off', () => {
    expect(
      welcomeDialogMode({
        stripeEnabled: false,
        hasSignupGrant: true,
        hasUsedCredits: false,
        hasOtherCredits: false,
      })
    ).toBe('gift');
  });

  it('hides the claim dialog after a grandfathered grant has been spent', () => {
    expect(
      welcomeDialogMode({
        stripeEnabled: true,
        hasSignupGrant: true,
        hasUsedCredits: true,
        hasOtherCredits: false,
      })
    ).toBe('none');
  });

  it('never shows for a team that already holds credits the grant did not give it', () => {
    expect(
      welcomeDialogMode({
        stripeEnabled: true,
        hasSignupGrant: false,
        hasUsedCredits: false,
        hasOtherCredits: true,
      })
    ).toBe('none');
    expect(
      welcomeDialogMode({
        stripeEnabled: false,
        hasSignupGrant: true,
        hasUsedCredits: false,
        hasOtherCredits: true,
      })
    ).toBe('none');
  });

  it('still offers the card gate after BYOK spend if the grant is unpaid', () => {
    expect(
      welcomeDialogMode({
        stripeEnabled: true,
        hasSignupGrant: false,
        hasUsedCredits: true,
        hasOtherCredits: false,
      })
    ).toBe('claim');
  });
});

describe('shouldOfferWelcomeClaim', () => {
  it('is true only for hosted Stripe with an unpaid grant', () => {
    const unpaid = { hasSignupGrant: false, hasOtherCredits: false };
    expect(shouldOfferWelcomeClaim({ stripeEnabled: true, ...unpaid })).toBe(
      SIGNUP_GRANT_MICROS > 0
    );
    expect(
      shouldOfferWelcomeClaim({
        stripeEnabled: true,
        hasSignupGrant: true,
        hasOtherCredits: false,
      })
    ).toBe(false);
    expect(shouldOfferWelcomeClaim({ stripeEnabled: false, ...unpaid })).toBe(
      false
    );
    // A team that already holds credits is not offered the grant.
    expect(
      shouldOfferWelcomeClaim({
        stripeEnabled: true,
        hasSignupGrant: false,
        hasOtherCredits: true,
      })
    ).toBe(false);
  });
});

describe('welcome credit grants', () => {
  let client: Client;
  let db: Database;
  let teamId = '';
  let userId = '';

  function scoped(team: string, uid: string): ScopedDb {
    const stub = { billing: createBillingMethods(db, team, uid) };
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double
    return stub as unknown as ScopedDb;
  }

  async function seed() {
    await db.delete(welcomeCardClaims);
    await db.delete(transactions);
    await db.delete(credits);
    await db.delete(teams);
    await db.delete(user);

    teamId = generateId();
    userId = generateId();
    await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
    await db
      .insert(user)
      .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  }

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    db = drizzle({ client, relations });
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    await seed();
  });

  it('credits the welcome grant once, then no-ops on replay', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    expect(await billing.hasSignupGrant()).toBe(false);

    const first = await grantSignupCredits({
      teamId,
      addCredits: billing.addCredits,
      alreadyGranted: await billing.hasSignupGrant(),
    });
    expect(first.granted).toBe(true);
    expect(first.newBalance).toBe(SIGNUP_GRANT_MICROS);
    expect(await billing.hasSignupGrant()).toBe(true);

    const second = await grantSignupCredits({
      teamId,
      addCredits: billing.addCredits,
      alreadyGranted: await billing.hasSignupGrant(),
    });
    expect(second.granted).toBe(false);
    expect(await billing.getBalance()).toBe(SIGNUP_GRANT_MICROS);

    const raced = await grantSignupCredits({
      teamId,
      addCredits: billing.addCredits,
      alreadyGranted: false,
    });
    expect(raced.granted).toBe(false);
    expect(await billing.getBalance()).toBe(SIGNUP_GRANT_MICROS);
  });

  it('treats a pre-gate signupGrant metadata row as already granted', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    await billing.addCredits(SIGNUP_GRANT_MICROS, {
      type: 'credit_adjustment',
      description: 'Welcome credit: $20.00',
      metadata: { signupGrant: true },
    });
    expect(await billing.hasSignupGrant()).toBe(true);

    const result = await grantSignupCredits({
      teamId,
      addCredits: billing.addCredits,
      alreadyGranted: await billing.hasSignupGrant(),
    });
    expect(result.granted).toBe(false);
    expect(await billing.getBalance()).toBe(SIGNUP_GRANT_MICROS);
  });

  it('lets only one team claim a given card fingerprint', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    expect(await billing.claimWelcomeCardFingerprint('fp_card_1')).toBe(true);
    expect(await billing.claimWelcomeCardFingerprint('fp_card_1')).toBe(true);

    const otherTeamId = generateId();
    await db
      .insert(teams)
      .values({ id: otherTeamId, name: 'Other', slug: 'other' });
    const other = createBillingMethods(db, otherTeamId, userId);
    expect(await other.claimWelcomeCardFingerprint('fp_card_1')).toBe(false);
  });

  it('credits the welcome grant once through grantWelcomeCreditsForTeam', async () => {
    const first = await grantWelcomeCreditsForTeam({
      scopedDb: scoped(teamId, userId),
      teamId,
      userId,
      source: 'claim',
      cardFingerprint: 'fp_team',
    });
    expect(first.granted).toBe(true);
    expect(await createBillingMethods(db, teamId, userId).getBalance()).toBe(
      SIGNUP_GRANT_MICROS
    );

    const replay = await grantWelcomeCreditsForTeam({
      scopedDb: scoped(teamId, userId),
      teamId,
      userId,
      source: 'claim',
      cardFingerprint: 'fp_team',
    });
    expect(replay.granted).toBe(false);
    expect(await createBillingMethods(db, teamId, userId).getBalance()).toBe(
      SIGNUP_GRANT_MICROS
    );
  });

  it('rejects a second team with the same card fingerprint', async () => {
    await grantWelcomeCreditsForTeam({
      scopedDb: scoped(teamId, userId),
      teamId,
      userId,
      source: 'setup_checkout',
      cardFingerprint: 'fp_shared',
    });

    const otherTeamId = generateId();
    await db
      .insert(teams)
      .values({ id: otherTeamId, name: 'Other', slug: 'other-grant' });

    await expect(
      grantWelcomeCreditsForTeam({
        scopedDb: scoped(otherTeamId, userId),
        teamId: otherTeamId,
        userId,
        source: 'claim',
        cardFingerprint: 'fp_shared',
      })
    ).rejects.toSatisfy(isWelcomeCardAlreadyClaimedError);
    expect(
      await createBillingMethods(db, otherTeamId, userId).getBalance()
    ).toBe(0);
  });

  it('stamps a grandfathered grant so the same card cannot pay another team', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    await billing.addCredits(SIGNUP_GRANT_MICROS, {
      type: 'credit_adjustment',
      description: 'Welcome credit: $20.00',
      metadata: { signupGrant: true },
    });

    const result = await grantWelcomeCreditsForTeam({
      scopedDb: scoped(teamId, userId),
      teamId,
      userId,
      source: 'purchase',
      cardFingerprint: 'fp_legacy',
    });
    expect(result.granted).toBe(false);
    expect(await billing.getBalance()).toBe(SIGNUP_GRANT_MICROS);

    const otherTeamId = generateId();
    await db
      .insert(teams)
      .values({ id: otherTeamId, name: 'Other', slug: 'other-legacy' });
    await expect(
      grantWelcomeCreditsForTeam({
        scopedDb: scoped(otherTeamId, userId),
        teamId: otherTeamId,
        userId,
        source: 'claim',
        cardFingerprint: 'fp_legacy',
      })
    ).rejects.toSatisfy(isWelcomeCardAlreadyClaimedError);
  });
});
