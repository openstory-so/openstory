/**
 * Anonymous user data migration
 * Transfers data from anonymous users to authenticated accounts
 */

import { eq, and } from "drizzle-orm";
import { sequences, styles, teamMembers, teams } from "@/db/schema";
import { withTransaction } from "@/db/transactions";

export interface AnonymousMigrationResult {
  migrationType: "merge" | "transfer";
  targetTeamId: string;
  sequencesTransferred: number;
  stylesTransferred: number;
}

/**
 * Transfer anonymous user data to authenticated account
 * Called by BetterAuth when linking anonymous account
 */
export async function transferAnonymousUserData(
  anonymousUserId: string,
  authenticatedUserId: string
): Promise<AnonymousMigrationResult> {
  return await withTransaction(async (tx) => {
    // 1. Get anonymous user's team
    const anonymousTeamMembership = await tx.query.teamMembers?.findFirst({
      where: eq(teamMembers.userId, anonymousUserId),
      with: {
        team: true,
      },
    });

    if (!anonymousTeamMembership) {
      throw new Error("Anonymous user has no team");
    }

    const anonymousTeamId = anonymousTeamMembership.teamId;

    // 2. Check if authenticated user already has a team
    const authenticatedTeamMembership = await tx.query.teamMembers?.findFirst({
      where: eq(teamMembers.userId, authenticatedUserId),
      with: {
        team: true,
      },
    });

    let targetTeamId: string;
    let migrationType: "merge" | "transfer";

    if (authenticatedTeamMembership) {
      // User already has a team - merge anonymous data into it
      targetTeamId = authenticatedTeamMembership.teamId;
      migrationType = "merge";

      console.log("[Migration] Merging anonymous data into existing team", {
        anonymousTeamId,
        targetTeamId,
      });
    } else {
      // User doesn't have a team - transfer ownership of anonymous team
      targetTeamId = anonymousTeamId;
      migrationType = "transfer";

      console.log("[Migration] Transferring anonymous team ownership", {
        anonymousTeamId,
        targetTeamId,
      });

      // Update team membership to authenticated user
      await tx
        .update(teamMembers)
        .set({
          userId: authenticatedUserId,
        })
        .where(
          and(
            eq(teamMembers.teamId, anonymousTeamId),
            eq(teamMembers.userId, anonymousUserId)
          )
        );
    }

    // 3. Transfer sequences
    const sequencesResult = await tx
      .update(sequences)
      .set({
        teamId: targetTeamId,
        updatedAt: new Date(),
      })
      .where(eq(sequences.teamId, anonymousTeamId))
      .returning();

    const sequencesTransferred = sequencesResult.length;

    // 4. Transfer styles
    const stylesResult = await tx
      .update(styles)
      .set({
        teamId: targetTeamId,
        updatedAt: new Date(),
      })
      .where(eq(styles.teamId, anonymousTeamId))
      .returning();

    const stylesTransferred = stylesResult.length;

    // 5. If merging, delete the anonymous team
    if (migrationType === "merge") {
      // Delete team membership first
      await tx
        .delete(teamMembers)
        .where(eq(teamMembers.teamId, anonymousTeamId));

      // Delete the anonymous team
      await tx.delete(teams).where(eq(teams.id, anonymousTeamId));

      console.log("[Migration] Deleted anonymous team after merge", {
        anonymousTeamId,
      });
    }

    console.log("[Migration] Data transfer complete", {
      migrationType,
      targetTeamId,
      sequencesTransferred,
      stylesTransferred,
    });

    return {
      migrationType,
      targetTeamId,
      sequencesTransferred,
      stylesTransferred,
    };
  });
}

