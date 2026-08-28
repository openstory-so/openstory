/**
 * Scoped Database Context
 * Factory that returns team-scoped query methods, auto-injecting teamId.
 * Sub-modules in ./scoped/ contain domain-specific methods.
 * Only this file and auth/config.ts should import getDb.
 */

import { getDb } from '#db-client';
import type { Sequence, User } from '@/lib/db/schema';
import {
  deviceCode,
  sequences,
  teamMembers,
  teams,
  user,
} from '@/lib/db/schema';
import type { TeamMemberRole } from '@/lib/db/schema/teams';
import { createAdminMethods } from '@/lib/db/scoped/admin';
import { createApiKeysMethods } from '@/lib/db/scoped/api-keys';
import { createBillingMethods } from '@/lib/db/scoped/billing';
import { createCharacterSheetVariantsMethods } from '@/lib/db/scoped/character-sheet-variants';
import {
  createComplianceMethods,
  createComplianceReadMethods,
  createModerationMethods,
  createProvenanceMethods,
  createPublicReportIntake,
} from '@/lib/db/scoped/compliance';
import { createCharactersMethods } from '@/lib/db/scoped/characters';
import { createFramePromptVersionsMethods } from '@/lib/db/scoped/frame-prompt-versions';
import { createFrameVariantsMethods } from '@/lib/db/scoped/frame-variants';
import { createFramesMethods } from '@/lib/db/scoped/frames';
import { createGeneratedAssetsMethods } from '@/lib/db/scoped/generated-assets';
import { createScenesMethods } from '@/lib/db/scoped/scenes';
import { createSceneScriptVersionsMethods } from '@/lib/db/scoped/scene-script-versions';
import { createSequenceEventsMethods } from '@/lib/db/scoped/sequence-events';
import { createShotPromptVersionsMethods } from '@/lib/db/scoped/shot-prompt-versions';
import { createRenderSegmentsMethods } from '@/lib/db/scoped/render-segments';
import { createShotVariantsMethods } from '@/lib/db/scoped/shot-variants';
import { createShotsMethods } from '@/lib/db/scoped/shots';
import { createVideoVariantsMethods } from '@/lib/db/scoped/video-variants';
import { createLibraryMethods } from '@/lib/db/scoped/library';
import {
  createLocationSheetsMethods,
  createLocationSheetsReadMethods,
  createLocationsMethods,
  createPublicLocationsReadMethods,
} from '@/lib/db/scoped/location-library';
import { createLocationSheetVariantsMethods } from '@/lib/db/scoped/location-sheet-variants';
import { createModelUsageMethods } from '@/lib/db/scoped/model-usage';
import { createSequenceElementsMethods } from '@/lib/db/scoped/sequence-elements';
import { createSequenceExportsMethods } from '@/lib/db/scoped/sequence-exports';
import { createSequenceLocationsMethods } from '@/lib/db/scoped/sequence-locations';
import { createSequenceMusicPromptVersionsMethods } from '@/lib/db/scoped/sequence-music-prompt-versions';
import { createSequenceVariantsMethods } from '@/lib/db/scoped/sequence-variants';
import {
  createSequenceMethods,
  createSequencesMethods,
} from '@/lib/db/scoped/sequences';
import {
  createPublicStylesReadMethods,
  createStylesMethods,
} from '@/lib/db/scoped/styles';
import {
  createPublicTalentReadMethods,
  createTalentMethods,
} from '@/lib/db/scoped/talent';
import { createTalentSheetVariantsMethods } from '@/lib/db/scoped/talent-sheet-variants';
import { createTeamManagementMethods } from '@/lib/db/scoped/team-management';
import { and, eq, lt, sql } from 'drizzle-orm';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'db', 'scoped']);

export type { UserActivityRow } from '@/lib/db/scoped/admin';

/**
 * Unscoped by nature (#1219): device codes belong to no team until approved,
 * and Better Auth's plugin only deletes a code when someone polls it after
 * expiry — never-polled codes would accumulate forever.
 */
export async function pruneExpiredDeviceCodes(): Promise<void> {
  await getDb().delete(deviceCode).where(lt(deviceCode.expiresAt, new Date()));
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
  const [result] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, sequenceId));
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
  return result ?? null;
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

    const teamName = authUser.name
      ? `${authUser.name}'s Team`
      : `Anonymous Team ${authUser.id.slice(0, 8)}`;
    const teamSlug = `team-${authUser.id.slice(0, 8)}`;

    const [team] = await db
      .insert(teams)
      .values({ name: teamName, slug: teamSlug })
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
    if (!team) throw new Error('Failed to create team');

    await db.insert(teamMembers).values({
      teamId: team.id,
      userId: authUser.id,
      role: 'owner',
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

    scenes: createScenesMethods(db),
    sceneScriptVersions: createSceneScriptVersionsMethods(db),
    shots: createShotsMethods(db),
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
 * rows; interpretation lives in `@/lib/compliance/enforcement`.
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
