import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { db } from "@/db";

/**
 * Transaction utilities
 * Helper functions for database transactions
 */

/**
 * Transaction type for use in service functions
 */
export type Transaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof import("@/db/schema").schema,
  any
>;

/**
 * Execute a function within a database transaction
 * Automatically commits on success, rolls back on error
 *
 * @example
 * const result = await withTransaction(async (tx) => {
 *   const team = await tx.insert(teams).values(teamData).returning();
 *   await tx.insert(teamMembers).values({ teamId: team[0].id, userId });
 *   return team[0];
 * });
 */
export async function withTransaction<T>(
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return await db.transaction(callback);
}

/**
 * Create a team with initial owner in a transaction
 */
export async function createTeamWithOwner(
  teamData: { name: string; slug: string },
  userId: string,
) {
  return await withTransaction(async (tx) => {
    const { teams, teamMembers } = await import("@/db/schema");

    // Create team
    const [team] = await tx.insert(teams).values(teamData).returning();

    // Add user as owner
    await tx.insert(teamMembers).values({
      teamId: team?.id,
      userId,
      role: "owner",
    });

    return team;
  });
}

/**
 * Transfer team ownership in a transaction
 */
export async function transferTeamOwnership(
  teamId: string,
  currentOwnerId: string,
  newOwnerId: string,
) {
  return await withTransaction(async (tx) => {
    const { teamMembers } = await import("@/db/schema");
    const { eq, and } = await import("drizzle-orm");

    // Downgrade current owner to admin
    await tx
      .update(teamMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, currentOwnerId),
        ),
      );

    // Upgrade new owner
    await tx
      .update(teamMembers)
      .set({ role: "owner" })
      .where(
        and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, newOwnerId)),
      );
  });
}

/**
 * Accept invitation and add member in a transaction
 */
export async function acceptInvitationAndAddMember(
  invitationId: string,
  teamId: string,
  userId: string,
  role: "owner" | "admin" | "member" | "viewer",
) {
  return await withTransaction(async (tx) => {
    const { teamInvitations, teamMembers } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    // Update invitation status
    await tx
      .update(teamInvitations)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(teamInvitations.id, invitationId));

    // Add team member
    const [member] = await tx
      .insert(teamMembers)
      .values({
        teamId,
        userId,
        role,
      })
      .returning();

    return member;
  });
}

/**
 * Delete sequence and all related data in a transaction
 * (Frames are cascade deleted by database, but this is for additional cleanup)
 */
export async function deleteSequenceWithCleanup(sequenceId: string) {
  return await withTransaction(async (tx) => {
    const { sequences, frames } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    // Delete frames first (explicit, though cascade would handle it)
    await tx.delete(frames).where(eq(frames.sequenceId, sequenceId));

    // Delete sequence
    await tx.delete(sequences).where(eq(sequences.id, sequenceId));
  });
}

/**
 * Bulk create frames for a sequence in a transaction
 */
export async function bulkCreateFrames(
  sequenceId: string,
  frameDescriptions: string[],
) {
  return await withTransaction(async (tx) => {
    const { frames } = await import("@/db/schema");

    const frameData = frameDescriptions.map((description, index) => ({
      sequenceId,
      orderIndex: index,
      description,
      durationMs: 3000,
      metadata: {},
    }));

    return await tx.insert(frames).values(frameData).returning();
  });
}
