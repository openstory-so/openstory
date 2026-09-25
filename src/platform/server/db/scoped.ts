/**
 * Scoped Database Context
 * Factory that returns team-scoped query methods, auto-injecting teamId.
 * Sub-modules in ./scoped/ contain domain-specific methods.
 * Raw `getDb` readers are allowlisted in `.oxlintrc.json` and pinned by
 * `db-access-allowlist.test.ts`; everything team-scoped goes through here.
 */

import { getDb } from '#db-client';
import type { Sequence, User } from '@/platform/server/db/schema';
import {
  teamMembers,
  teams,
  deviceCode,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  sequences,
  user,
} from '@/platform/server/db/schema';
import type { TeamMemberRole } from '@/platform/server/db/schema/teams';
import {
  grantsWelcomeCreditsOnSignup,
  SIGNUP_GRANT_MICROS,
  signupGrantIdempotencyKey,
} from '@/billing/constants';
import { microsToDisplayUsd } from '@/billing/money';
import { createAdminMethods } from '@/platform/server/db/scoped/admin';
import { createApiKeysMethods } from '@/models/server/db/api-keys';
import { createBillingMethods } from '@/billing/server/db/billing';
import { createCharacterSheetVariantsMethods } from '@/cast/server/db/character-sheet-variants';
import {
  createComplianceMethods,
  createComplianceReadMethods,
  createModerationMethods,
  createProvenanceMethods,
  createPublicReportIntake,
} from '@/platform/server/db/scoped/compliance';
import { createCharactersMethods } from '@/cast/server/db/characters';
import { createFramePromptVersionsMethods } from '@/shots/server/db/frame-prompt-versions';
import { createFrameVariantsMethods } from '@/stills/server/db/frame-variants';
import { createFramesMethods } from '@/shots/server/db/frames';
import { createGeneratedAssetsMethods } from '@/models/server/db/generated-assets';
import { createScenesMethods } from '@/shots/server/db/scenes';
import { createProductionReadMethods } from '@/shots/server/db/production-reads';
import { createSceneScriptVersionsMethods } from '@/shots/server/db/scene-script-versions';
import { createShotDialogueMethods } from '@/shots/server/db/shot-dialogue';
import { createSequenceEventsMethods } from '@/sequences/server/db/sequence-events';
import { createShotPromptVersionsMethods } from '@/shots/server/db/shot-prompt-versions';
import { createRenderSegmentsMethods } from '@/motion/server/db/render-segments';
import { createShotVariantsMethods } from '@/shots/server/db/shot-variants';
import { createShotsMethods } from '@/shots/server/db/shots';
import { createVideoVariantsMethods } from '@/motion/server/db/video-variants';
import { createLibraryMethods } from '@/look/server/db/library';
import {
  createLocationSheetsMethods,
  createLocationSheetsReadMethods,
  createLocationsMethods,
  createPublicLocationsReadMethods,
} from '@/cast/server/db/location-library';
import { createLocationSheetVariantsMethods } from '@/cast/server/db/location-sheet-variants';
import { createBytePlusAssetsMethods } from '@/models/server/db/byteplus-assets';
import { createModelUsageMethods } from '@/billing/server/db/model-usage';
import { createSequenceElementsMethods } from '@/cast/server/db/sequence-elements';
import { createSequenceExportsMethods } from '@/sequences/server/db/sequence-exports';
import { createSequenceLocationsMethods } from '@/cast/server/db/sequence-locations';
import { createSequenceMusicPromptVersionsMethods } from '@/audio/server/db/sequence-music-prompt-versions';
import { createSequenceVariantsMethods } from '@/audio/server/db/sequence-variants';
import {
  createSequenceMethods,
  createSequencesMethods,
  selectSequencesFrom,
} from '@/sequences/server/db/sequences';
import {
  createPublicStylesReadMethods,
  createStylesMethods,
} from '@/look/server/db/styles';
import {
  createPublicTalentReadMethods,
  createTalentMethods,
} from '@/cast/server/db/talent';
import { createTalentSheetVariantsMethods } from '@/cast/server/db/talent-sheet-variants';
import { createTeamManagementMethods } from '@/platform/server/db/scoped/team-management';
import { and, inArray, isNull, lt, notExists, eq, sql } from 'drizzle-orm';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'db', 'scoped']);

export type { UserActivityRow } from '@/platform/server/db/scoped/admin';

/**
 * Unscoped by nature (#1219): device codes belong to no team until approved,
 * and Better Auth's plugin only deletes a code when someone polls it after
 * expiry — never-polled codes would accumulate forever.
 */
export async function pruneExpiredDeviceCodes(): Promise<void> {
  await getDb().delete(deviceCode).where(lt(deviceCode.expiresAt, new Date()));
}

/** Long enough for a fork registered at boot to see its first "Connect" click. */
const ORPHANED_OAUTH_CLIENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Housekeeping for self-registered OAuth clients (#1456). RFC 7591 dynamic
 * client registration is open (the MCP spec expects it), so anyone can create
 * `oauth_client` rows. Dynamically registered clients (no owning user or
 * reference) older than the grace period with neither a consent nor a refresh
 * token are deleted; the cascade FKs take stray tokens with them. Not a 24h
 * cron: opportunistic on `POST /oauth2/register`, so idle orphans wait until
 * the next DCR. Module-level and unscoped like `pruneExpiredDeviceCodes`.
 * Returns the number removed.
 */
export async function pruneOrphanedOAuthClients(
  now = new Date()
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - ORPHANED_OAUTH_CLIENT_GRACE_MS);
  const orphaned = and(
    isNull(oauthClient.userId),
    isNull(oauthClient.referenceId),
    lt(oauthClient.createdAt, cutoff),
    notExists(
      db
        .select({ one: sql`1` })
        .from(oauthConsent)
        .where(sql`${oauthConsent.clientId} = ${oauthClient.clientId}`)
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(oauthRefreshToken)
        .where(sql`${oauthRefreshToken.clientId} = ${oauthClient.clientId}`)
    )
  );
  const orphans = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(orphaned)
    .limit(100);
  if (orphans.length === 0) return 0;
  // Re-apply the predicate on DELETE so a consent that lands between select
  // and delete is not cascade-removed.
  await db.delete(oauthClient).where(
    and(
      inArray(
        oauthClient.clientId,
        orphans.map((row) => row.clientId)
      ),
      orphaned
    )
  );
  return orphans.length;
}

/**
 * Mark this user's refresh tokens for the client revoked so Settings revoke
 * cannot be bypassed by refresh. Access JWTs are not checked against this
 * table and expire on their own (≤1h). Unscoped: a grant is the user's.
 */
export async function revokeOAuthGrantTokens(
  userId: string,
  clientId: string,
  now = new Date()
): Promise<void> {
  const db = getDb();
  await db
    .update(oauthRefreshToken)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.clientId, clientId),
        isNull(oauthRefreshToken.revoked)
      )
    );
  await db
    .update(oauthAccessToken)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        eq(oauthAccessToken.clientId, clientId),
        isNull(oauthAccessToken.revoked)
      )
    );
}

/**
 * Resolve a user's default team (highest-role team).
 * Module-level function for bootstrap before scopedDb exists.
 */
export async function resolveUserTeam(
  userId: string
): Promise<{ teamId: string; role: TeamMemberRole; teamName: string } | null> {
  const db = getDb();
  const [result] = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      teamName: teams.name,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(
      sql`CASE
        WHEN ${teamMembers.role} = 'owner' THEN 1
        WHEN ${teamMembers.role} = 'admin' THEN 2
        WHEN ${teamMembers.role} = 'member' THEN 3
        WHEN ${teamMembers.role} = 'viewer' THEN 4
        ELSE 5
      END`
    )
    .limit(1);

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
  return result ?? null;
}

/**
 * Check if a user is a member of a specific team and return their role.
 * Module-level function — does not require a scopedDb instance.
 */
export async function getUserTeamMembership(
  userId: string,
  teamId: string
): Promise<{ teamId: string; role: TeamMemberRole; teamName: string } | null> {
  const db = getDb();
  const [result] = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      teamName: teams.name,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
    .limit(1);

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
  return result ?? null;
}

/**
 * Public (anonymous) read surface — everything a logged-out visitor can read.
 * Each function delegates to a createPublic*ReadMethods factory that takes no
 * team scope at all, so these code paths cannot express a team-scoped query;
 * the isPublic filters inside the factories are the entire data boundary.
 */

/**
 * List publicly-shared styles without any team scoping or auth.
 * Used to populate the style picker for anonymous (logged-out) visitors so
 * they can compose a sequence before being prompted to sign in.
 */
export async function listPublicStyles() {
  return createPublicStylesReadMethods(getDb()).list();
}

/**
 * List public ("system") talent without team scoping or auth. Lets anonymous
 * visitors browse and pre-cast system talent on the public new-sequence
 * screen and talent library page.
 */
export async function listPublicTalent(options?: { favoritesOnly?: boolean }) {
  return createPublicTalentReadMethods(getDb()).list(options);
}

/**
 * List public ("system") library locations without team scoping or auth.
 */
export async function listPublicLibraryLocations() {
  return createPublicLocationsReadMethods(getDb()).list();
}

/**
 * Fetch a public ("system") talent with its sheets and media, no auth.
 * Returns undefined if the talent isn't public. Lets anonymous visitors open a
 * talent detail page read-only.
 */
export async function getPublicTalentWithRelations(talentId: string) {
  return createPublicTalentReadMethods(getDb()).getWithRelations(talentId);
}

/**
 * Fetch a public ("system") library location with its sheets, no auth.
 * Returns null if the location isn't public. Mirrors getLibraryLocationByIdFn's
 * shape so the same detail page renders for anonymous visitors.
 */
export async function getPublicLibraryLocationById(locationId: string) {
  const db = getDb();
  const location =
    await createPublicLocationsReadMethods(db).getById(locationId);
  if (!location) return null;
  const sheets = await createLocationSheetsReadMethods(db).list(locationId);
  return { ...location, sequenceTitle: 'Library' as const, sheets };
}

/**
 * Get a sequence by ID without team scoping.
 * Only for admin operations where team context isn't available yet.
 */
export async function getSequenceByIdUnscoped(
  sequenceId: string
): Promise<Sequence | null> {
  const db = getDb();
  const [result] = await selectSequencesFrom(db).where(
    eq(sequences.id, sequenceId)
  );
  return result ?? null;
}

/**
 * Create a user's default team with them as owner. The one place the
 * sign-up bootstrap SQL lives: the Better Auth `user.create` hook and
 * `ensureUserAndTeam` both call it, so neither touches `teams` /
 * `team_members` directly.
 */
export async function createDefaultTeam(input: {
  userId: string;
  teamName: string;
  /**
   * Sign-up grant (#1047). Hosted Stripe grants on save-card / purchase
   * (#1516); e2e and self-host (no Stripe) still fund a first short here. Off
   * on the anonymous bootstrap path. A $0 grant writes no ledger row (#1529).
   */
  welcomeCredit?: boolean;
}) {
  const db = getDb();
  const [team] = await db
    .insert(teams)
    .values({ name: input.teamName, slug: `team-${input.userId.slice(0, 8)}` })
    .returning();
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
  if (!team) {
    throw new Error(`Failed to create default team for user ${input.userId}`);
  }
  await db.insert(teamMembers).values({
    teamId: team.id,
    userId: input.userId,
    role: 'owner',
  });
  if (
    input.welcomeCredit &&
    SIGNUP_GRANT_MICROS > 0 &&
    grantsWelcomeCreditsOnSignup()
  ) {
    await createBillingMethods(db, team.id, input.userId).addCredits(
      SIGNUP_GRANT_MICROS,
      {
        type: 'credit_adjustment',
        description: `Welcome credit: ${microsToDisplayUsd(SIGNUP_GRANT_MICROS)}`,
        idempotencyKey: signupGrantIdempotencyKey(team.id),
        metadata: { signupGrant: true },
      }
    );
  }
  return team;
}

/** Email + name for a PostHog identify. Null when the row is missing. */
export async function getUserIdentity(
  userId: string
): Promise<{ email: string; name: string } | null> {
  const [row] = await getDb()
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Ensure user exists in database with team membership.
 * Creates user record, team, and membership if they don't exist.
 * Bootstrap function — does not require a scopedDb instance.
 */
export async function ensureUserAndTeam(authUser: {
  id: string;
  name?: string | null;
  email?: string | null;
}): Promise<{
  success: boolean;
  data?: User & { teamMembers?: Array<{ teamId: string; role: string }> };
  error?: string;
}> {
  try {
    const db = getDb();

    const foundUser = await db.query.user.findFirst({
      where: { id: authUser.id },
    });

    if (foundUser) {
      const memberships = await db
        .select({ teamId: teamMembers.teamId, role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.userId, authUser.id));

      if (memberships.length > 0) {
        return {
          success: true,
          data: { ...foundUser, teamMembers: memberships },
        };
      }
    }

    await db
      .insert(user)
      .values({
        id: authUser.id,
        name: authUser.name || 'Anonymous',
        email: authUser.email || `${authUser.id}@anonymous.local`,
      })
      .onConflictDoNothing();

    const team = await createDefaultTeam({
      userId: authUser.id,
      teamName: authUser.name
        ? `${authUser.name}'s Team`
        : `Anonymous Team ${authUser.id.slice(0, 8)}`,
    });

    const createdUser = await db.query.user.findFirst({
      where: { id: authUser.id },
    });

    if (!createdUser) throw new Error('Failed to retrieve created user');

    return {
      success: true,
      data: {
        ...createdUser,
        teamMembers: [{ teamId: team.id, role: 'owner' }],
      },
    };
  } catch (error) {
    logger.error('Error:', { err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unexpected error',
    };
  }
}

/**
 * Full scoped DB — requires userId for write operations that auto-inject audit fields.
 */
export function createScopedDb(teamId: string, userId: string) {
  const db = getDb();
  const reads = createProductionReadMethods(db, teamId);

  return {
    teamId,
    userId,

    sequences: createSequencesMethods(db, teamId, userId),
    sequence: (sequenceId: string) => createSequenceMethods(db, sequenceId),

    talent: createTalentMethods(db, teamId, userId),
    styles: createStylesMethods(db, teamId, userId),
    locations: createLocationsMethods(db, teamId, userId),
    locationSheets: createLocationSheetsMethods(db),
    library: createLibraryMethods(db, teamId),

    scenes: { ...createScenesMethods(db), ...reads.scenes },
    sceneScriptVersions: createSceneScriptVersionsMethods(db),
    shotDialogue: createShotDialogueMethods(db),
    shots: { ...createShotsMethods(db), ...reads.shots },
    shotVariants: createShotVariantsMethods(db),
    // SSF redesign (#990) — render segments (scene render units) + flat video
    // versions per (segment, model); replaces the shot_variants video slice.
    renderSegments: createRenderSegmentsMethods(db),
    videoVariants: createVideoVariantsMethods(db),
    shotPromptVersions: createShotPromptVersionsMethods(db),
    // SSF redesign (#988) — frames are the IMAGE unit (still keyframes per
    // shot); frame_variants the flat image versions; frame_prompt_versions the
    // visual-prompt history; sequence_events the append-only activity log.
    frames: createFramesMethods(db),
    frameVariants: createFrameVariantsMethods(db),
    framePromptVersions: createFramePromptVersionsMethods(db),
    sequenceEvents: createSequenceEventsMethods(db),
    characterSheetVariants: createCharacterSheetVariantsMethods(db),
    locationSheetVariants: createLocationSheetVariantsMethods(db),
    talentSheetVariants: createTalentSheetVariantsMethods(db, teamId),
    sequenceMusicPromptVersions: createSequenceMusicPromptVersionsMethods(db),
    sequenceVariants: createSequenceVariantsMethods(db),
    sequenceExports: createSequenceExportsMethods(db),

    characters: createCharactersMethods(db),
    sequenceLocations: createSequenceLocationsMethods(db),
    sequenceElements: createSequenceElementsMethods(db),

    // Direct model access (#458) — flat team-scoped runs of arbitrary fal
    // endpoints, decoupled from the sequence graph.
    generatedAssets: createGeneratedAssetsMethods(db, teamId, userId),

    // Platform-global pricing telemetry (#1069) — not team-scoped.
    modelUsage: createModelUsageMethods(db),

    // BytePlus ACR slot ledger (#1361) — also platform-global: the asset
    // slots are per BytePlus ACCOUNT, shared by every team, so there is
    // nothing to scope. Policy lives in `@/models/server/byteplus-asset-pool`.
    bytePlusAssets: createBytePlusAssetsMethods(db),

    billing: createBillingMethods(db, teamId, userId),
    apiKeys: createApiKeysMethods(db, teamId, userId),
    teamManagement: createTeamManagementMethods(db, teamId, userId),

    // Compliance (#1180). `provenance` is its own domain rather than a member
    // of `compliance` because workflows must reach it and the workflow write
    // surface only strips read methods at the top level — see the comment on
    // createProvenanceMethods.
    provenance: createProvenanceMethods(db, teamId, userId),
    compliance: createComplianceMethods(db, teamId, userId),
  };
}

export type ScopedDb = ReturnType<typeof createScopedDb>;

export function createSystemAdminScopedDb() {
  const db = getDb();

  return {
    admin: createAdminMethods(db),
    // Cross-team moderation (#1180): the report queue, enforcement, and
    // trace lookup. Only reachable through the system-admin scope, so a
    // team-scoped caller cannot read another team's reports.
    moderation: createModerationMethods(db),
  };
}

/**
 * Enforcement rows for one user (#1180).
 *
 * Module-level and unscoped, like `resolveUserTeam` above, for the same reason:
 * the generation gate runs before any team scope is meaningful, and an
 * enforcement action follows the person rather than the workspace. Returns raw
 * rows; interpretation lives in `@/platform/server/compliance/enforcement`.
 */
export async function loadComplianceRecords(
  userId: string,
  teamId?: string | null
) {
  const reads = createComplianceReadMethods(getDb());
  const enforcement = await reads.listEnforcementFor(userId, teamId);
  return { enforcement };
}

/**
 * Accept an abuse report from an unauthenticated visitor.
 *
 * Module-level with no scope at all — the person whose likeness was misused has
 * no account, and a takedown channel that requires one is not a takedown
 * channel. Mirrors the `listPublic*` factories: the code path cannot express a
 * team-scoped query.
 */
export async function submitPublicContentReport(
  input: Parameters<ReturnType<typeof createPublicReportIntake>['submit']>[0]
) {
  return createPublicReportIntake(getDb()).submit(input);
}
