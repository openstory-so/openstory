/**
 * Scoped Database Context
 * Factory that returns organization-scoped query methods, auto-injecting organizationId.
 * Sub-modules in ./scoped/ contain domain-specific methods.
 * Raw `getDb` readers are allowlisted in `.oxlintrc.json` and pinned by
 * `db-access-allowlist.test.ts`; everything organization-scoped goes through here.
 */

import { getDb } from '#db-client';
import type { Sequence, User } from '@/platform/server/db/schema';
import {
  apikey,
  deviceGrantOrganizations,
  member,
  organization,
  deviceCode,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  sequences,
  user,
} from '@/platform/server/db/schema';
import type { OrganizationMemberRole } from '@/platform/server/db/schema/organization';
import { createAdminMethods } from '@/platform/server/db/scoped/admin';
import { createSearchMethods } from '@/platform/server/db/scoped/search';
import { createApiKeysMethods } from '@/models/server/db/api-keys';
import { createBillingMethods } from '@/billing/server/db/billing';
import { createCharacterLooksMethods } from '@/cast/server/db/character-looks';
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
import { createShotSpecVersionsMethods } from '@/shots/server/db/shot-spec-versions';
import { createSequenceEventsMethods } from '@/sequences/server/db/sequence-events';
import { createShotPromptVersionsMethods } from '@/shots/server/db/shot-prompt-versions';
import { createRenderSegmentsMethods } from '@/motion/server/db/render-segments';
import { createShotVariantsMethods } from '@/shots/server/db/shot-variants';
import { createShotsMethods } from '@/shots/server/db/shots';
import { createVideoVariantsMethods } from '@/motion/server/db/video-variants';
import { createLibraryMethods } from '@/look/server/db/library';
import { createLocationsMethods } from '@/cast/server/db/locations';
import { createLocationSheetVariantsMethods } from '@/cast/server/db/location-sheet-variants';
import { createBytePlusAssetsMethods } from '@/models/server/db/byteplus-assets';
import { createModelUsageMethods } from '@/billing/server/db/model-usage';
import { createSequenceElementsMethods } from '@/cast/server/db/sequence-elements';
import { createSequenceExportsMethods } from '@/sequences/server/db/sequence-exports';
import {
  createPublicStitchReads,
  createStitchesMethods,
} from '@/stitches/server/db/stitches';
import { createAssistantMethods } from '@/assistant/server/db/assistant';
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
import { createOrganizationManagementMethods } from '@/platform/server/db/scoped/organization-management';
import { and, asc, inArray, isNull, lt, notExists, eq, sql } from 'drizzle-orm';
import { apiKeyMetadataSchema } from '@/platform/server/auth/public-api-key';

export type { UserActivityRow } from '@/platform/server/db/scoped/admin';

/**
 * Unscoped by nature (#1219): device codes belong to no organization until approved,
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

type ResolvedOrganization = {
  organizationId: string;
  role: OrganizationMemberRole;
  organizationName: string;
};

function asMemberRole(role: string): OrganizationMemberRole {
  if (role === 'owner' || role === 'admin' || role === 'member') {
    return role;
  }
  throw new Error(`Unknown organization role "${role}"`);
}

/** Membership of one organization, or null. */
export async function getUserOrganizationMembership(
  userId: string,
  organizationId: string
): Promise<ResolvedOrganization | null> {
  const [result] = await getDb()
    .select({
      organizationId: member.organizationId,
      role: member.role,
      organizationName: organization.name,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);
  if (!result) return null;
  return { ...result, role: asMemberRole(result.role) };
}

export type OrganizationOption = { id: string; name: string };

/** Every organization the user belongs to, by name. */
export async function listUserOrganizations(
  userId: string
): Promise<OrganizationOption[]> {
  return getDb()
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name));
}

/** Record the organization a device login was approved for. */
export async function recordDeviceGrantOrganization(input: {
  userCode: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({ id: deviceCode.id })
    .from(deviceCode)
    .where(
      and(
        eq(deviceCode.userCode, input.userCode),
        eq(deviceCode.userId, input.userId)
      )
    )
    .limit(1);
  if (!row) throw new Error('Device login code not found');
  await db
    .insert(deviceGrantOrganizations)
    .values({ deviceCodeId: row.id, organizationId: input.organizationId })
    .onConflictDoUpdate({
      target: deviceGrantOrganizations.deviceCodeId,
      set: { organizationId: input.organizationId },
    });
}

/** The organization a device code was approved for, or null before approval. */
export async function getDeviceGrantOrganizationId(
  deviceCodeValue: string
): Promise<string | null> {
  const [row] = await getDb()
    .select({ organizationId: deviceGrantOrganizations.organizationId })
    .from(deviceGrantOrganizations)
    .innerJoin(
      deviceCode,
      eq(deviceGrantOrganizations.deviceCodeId, deviceCode.id)
    )
    .where(eq(deviceCode.deviceCode, deviceCodeValue))
    .limit(1);
  return row?.organizationId ?? null;
}

/** The organization a new session starts in: the user's first membership. */
export async function getFirstOrganizationId(
  userId: string
): Promise<string | null> {
  const [row] = await getDb()
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);
  return row?.organizationId ?? null;
}

/** The organization an `osk_` key acts for, from the key's `metadata`. */
export async function getApiKeyOrganizationId(
  keyId: string
): Promise<string | null> {
  const [row] = await getDb()
    .select({ metadata: apikey.metadata })
    .from(apikey)
    .where(eq(apikey.id, keyId))
    .limit(1);
  if (!row?.metadata) return null;
  return apiKeyMetadataSchema.parse(JSON.parse(row.metadata)).organizationId;
}

/**
 * Public (anonymous) read surface — everything a logged-out visitor can read.
 * Each function delegates to a createPublic*ReadMethods factory that takes no
 * organization scope at all, so these code paths cannot express an organization-scoped query;
 * the isPublic filters inside the factories are the entire data boundary.
 */

/**
 * List publicly-shared styles without any organization scoping or auth.
 * Used to populate the style picker for anonymous (logged-out) visitors so
 * they can compose a sequence before being prompted to sign in.
 */
export async function listPublicStyles() {
  return createPublicStylesReadMethods(getDb()).list();
}

/**
 * Get a sequence by ID without organization scoping.
 * Only for admin operations where organization context isn't available yet.
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
 * Create a user's default organization with them as owner. Called from the Better Auth
 * `user.create` hook. The membership id is the user id because
 * this is their only membership.
 */
export async function createDefaultOrganization(input: {
  userId: string;
  organizationName: string;
}) {
  const db = getDb();
  const [created] = await db
    .insert(organization)
    .values({
      name: input.organizationName,
      slug: `org-${input.userId.slice(0, 8)}`,
    })
    .returning();
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
  if (!created) {
    throw new Error(
      `Failed to create default organization for user ${input.userId}`
    );
  }
  await db.insert(member).values({
    id: input.userId,
    organizationId: created.id,
    userId: input.userId,
    role: 'owner',
    createdAt: new Date(),
  });
  return created;
}

/** A user row by id, typed like a session's user. Null when missing. */
export async function getUserById(userId: string): Promise<User | null> {
  const row = await getDb().query.user.findFirst({ where: { id: userId } });
  return row ?? null;
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
 * Full scoped DB — requires userId for write operations that auto-inject audit fields.
 */
export function createScopedDb(organizationId: string, userId: string) {
  const db = getDb();
  const reads = createProductionReadMethods(db, organizationId);

  return {
    organizationId,
    userId,

    sequences: createSequencesMethods(db, organizationId, userId),
    sequence: (sequenceId: string) => createSequenceMethods(db, sequenceId),

    styles: createStylesMethods(db, organizationId, userId),
    locations: createLocationsMethods(db, organizationId),
    library: createLibraryMethods(db, organizationId),

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
    // #1915 — the structured shot spec its prompts are derived from.
    shotSpecVersions: createShotSpecVersionsMethods(db),
    // SSF redesign (#988) — frames are the IMAGE unit (still keyframes per
    // shot); frame_variants the flat image versions; frame_prompt_versions the
    // visual-prompt history; sequence_events the append-only activity log.
    frames: createFramesMethods(db),
    frameVariants: createFrameVariantsMethods(db),
    framePromptVersions: createFramePromptVersionsMethods(db),
    sequenceEvents: createSequenceEventsMethods(db),
    characterSheetVariants: createCharacterSheetVariantsMethods(
      db,
      organizationId
    ),
    characterLooks: createCharacterLooksMethods(db, organizationId),
    locationSheetVariants: createLocationSheetVariantsMethods(
      db,
      organizationId
    ),
    sequenceMusicPromptVersions: createSequenceMusicPromptVersionsMethods(db),
    sequenceVariants: createSequenceVariantsMethods(db),
    sequenceExports: createSequenceExportsMethods(db),
    stitches: createStitchesMethods(db, organizationId, userId),
    // In-app assistant threads and their persistence stores (#2155).
    assistant: createAssistantMethods(db, organizationId, userId),

    characters: createCharactersMethods(db, organizationId),
    sequenceElements: createSequenceElementsMethods(db),

    // Direct model access (#458) — flat organization-scoped runs of arbitrary fal
    // endpoints, decoupled from the sequence graph.
    generatedAssets: createGeneratedAssetsMethods(db, organizationId, userId),

    // Platform-global pricing telemetry (#1069) — not organization-scoped.
    modelUsage: createModelUsageMethods(db),

    // BytePlus ACR slot ledger (#1361) — also platform-global: the asset
    // slots are per BytePlus ACCOUNT, shared by every organization, so there is
    // nothing to scope. Policy lives in `@/models/server/byteplus-asset-pool`.
    bytePlusAssets: createBytePlusAssetsMethods(db),

    billing: createBillingMethods(db, organizationId, userId),
    apiKeys: createApiKeysMethods(db, organizationId, userId),
    organizationManagement: createOrganizationManagementMethods(
      db,
      organizationId
    ),
    search: createSearchMethods(db, organizationId),

    // Compliance (#1180). `provenance` is its own domain rather than a member
    // of `compliance` because workflows must reach it and the workflow write
    // surface only strips read methods at the top level — see the comment on
    // createProvenanceMethods.
    provenance: createProvenanceMethods(db, organizationId, userId),
    compliance: createComplianceMethods(db, organizationId, userId),
  };
}

export type ScopedDb = ReturnType<typeof createScopedDb>;

export function createSystemAdminScopedDb() {
  const db = getDb();

  return {
    admin: createAdminMethods(db),
    // Cross-organization moderation (#1180): the report queue, enforcement, and
    // trace lookup. Only reachable through the system-admin scope, so a
    // organization-scoped caller cannot read another organization's reports.
    moderation: createModerationMethods(db),
  };
}

/**
 * Enforcement rows for one user (#1180).
 *
 * Module-level and unscoped, like `getUserOrganizationMembership` above, for the same reason:
 * the generation gate runs before any organization scope is meaningful, and an
 * enforcement action follows the person rather than the workspace. Returns raw
 * rows; interpretation lives in `@/platform/server/compliance/enforcement`.
 */
export async function loadComplianceRecords(
  userId: string,
  organizationId?: string | null
) {
  const reads = createComplianceReadMethods(getDb());
  const enforcement = await reads.listEnforcementFor(userId, organizationId);
  return { enforcement };
}

/**
 * Accept an abuse report from an unauthenticated visitor.
 *
 * Module-level with no scope at all — the person whose likeness was misused has
 * no account, and a takedown channel that requires one is not a takedown
 * channel. Mirrors the `listPublic*` factories: the code path cannot express a
 * organization-scoped query.
 */
export async function submitPublicContentReport(
  input: Parameters<ReturnType<typeof createPublicReportIntake>['submit']>[0]
) {
  return createPublicReportIntake(getDb()).submit(input);
}

/**
 * One shared stitch by id (#2127), for the public page at /stitch/<id>.
 *
 * Module-level and unscoped, like `submitPublicContentReport`: the viewer has
 * no organization, and the ULID is the only credential, as it is for a stored media URL.
 */
export async function getPublicStitch(id: string) {
  return createPublicStitchReads(getDb()).getById(id);
}
