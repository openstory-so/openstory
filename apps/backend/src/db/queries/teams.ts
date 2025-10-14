import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { teams, teamMembers, teamInvitations } from "@/db/schema";
import type { NewTeam, NewTeamMember, NewTeamInvitation } from "@/db/schema";

/**
 * Team query helpers
 * Type-safe database operations for teams
 */

/**
 * Get team by ID with members
 */
export async function getTeamById(teamId: string) {
  return await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    with: {
      members: {
        with: {
          user: true,
        },
      },
    },
  });
}

/**
 * Get team by slug
 */
export async function getTeamBySlug(slug: string) {
  return await db.query.teams.findFirst({
    where: eq(teams.slug, slug),
  });
}

/**
 * Get all teams for a user
 */
export async function getUserTeams(userId: string) {
  return await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    with: {
      team: true,
    },
  });
}

/**
 * Create a new team
 */
export async function createTeam(data: NewTeam) {
  const [team] = await db.insert(teams).values(data).returning();
  return team;
}

/**
 * Update team
 */
export async function updateTeam(teamId: string, data: Partial<NewTeam>) {
  const [team] = await db
    .update(teams)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(teams.id, teamId))
    .returning();
  return team;
}

/**
 * Delete team
 */
export async function deleteTeam(teamId: string) {
  await db.delete(teams).where(eq(teams.id, teamId));
}

/**
 * Add member to team
 */
export async function addTeamMember(data: NewTeamMember) {
  const [member] = await db.insert(teamMembers).values(data).returning();
  return member;
}

/**
 * Remove member from team
 */
export async function removeTeamMember(teamId: string, userId: string) {
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
}

/**
 * Get team member
 */
export async function getTeamMember(teamId: string, userId: string) {
  return await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    with: {
      user: true,
    },
  });
}

/**
 * Update team member role
 */
export async function updateTeamMemberRole(
  teamId: string,
  userId: string,
  role: "owner" | "admin" | "member" | "viewer"
) {
  const [member] = await db
    .update(teamMembers)
    .set({ role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning();
  return member;
}

/**
 * Create team invitation
 */
export async function createTeamInvitation(data: NewTeamInvitation) {
  const [invitation] = await db.insert(teamInvitations).values(data).returning();
  return invitation;
}

/**
 * Get pending invitations for team
 */
export async function getTeamInvitations(teamId: string) {
  return await db.query.teamInvitations.findMany({
    where: and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, "pending")),
    orderBy: [desc(teamInvitations.createdAt)],
  });
}

/**
 * Get invitation by token
 */
export async function getInvitationByToken(token: string) {
  return await db.query.teamInvitations.findFirst({
    where: eq(teamInvitations.token, token),
    with: {
      team: true,
      inviter: true,
    },
  });
}

/**
 * Accept invitation
 */
export async function acceptInvitation(invitationId: string) {
  const [invitation] = await db
    .update(teamInvitations)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(teamInvitations.id, invitationId))
    .returning();
  return invitation;
}

/**
 * Decline invitation
 */
export async function declineInvitation(invitationId: string) {
  const [invitation] = await db
    .update(teamInvitations)
    .set({
      status: "declined",
      declinedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(teamInvitations.id, invitationId))
    .returning();
  return invitation;
}

