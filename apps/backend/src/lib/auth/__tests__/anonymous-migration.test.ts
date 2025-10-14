import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db, closeDatabase } from "@/db";
import { createTeamWithOwner } from "@/db/transactions";
import { createSequence } from "@/db/queries/sequences";
import { createStyle } from "@/db/queries/styles";
import { getTeamById } from "@/db/queries/teams";
import { transferAnonymousUserData } from "../anonymous-migration";

describe("Anonymous User Migration", () => {
  let anonymousUserId: string;
  let authenticatedUserId: string;
  let anonymousTeamId: string;

  beforeAll(async () => {
    // Create mock user IDs
    anonymousUserId = "00000000-0000-0000-0000-000000000010";
    authenticatedUserId = "00000000-0000-0000-0000-000000000011";

    // Create anonymous user's team
    const anonymousTeam = await createTeamWithOwner(
      {
        name: "Anonymous User Team",
        slug: `anon-team-${Date.now()}`,
      },
      anonymousUserId
    );

    anonymousTeamId = anonymousTeam.id;

    // Create some content for anonymous user
    await createSequence({
      teamId: anonymousTeamId,
      title: "Anonymous Sequence 1",
      status: "draft",
    });

    await createSequence({
      teamId: anonymousTeamId,
      title: "Anonymous Sequence 2",
      status: "draft",
    });

    await createStyle({
      teamId: anonymousTeamId,
      name: "Anonymous Style",
      configJson: {},
      isPublic: false,
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.execute(`DELETE FROM teams WHERE slug LIKE 'anon-team-%'`);
    await db.execute(`DELETE FROM teams WHERE slug LIKE 'auth-team-%'`);
    await closeDatabase();
  });

  describe("Transfer to new user (no existing team)", () => {
    test("should transfer team ownership", async () => {
      const result = await transferAnonymousUserData(
        anonymousUserId,
        authenticatedUserId
      );

      expect(result.migrationType).toBe("transfer");
      expect(result.targetTeamId).toBe(anonymousTeamId);
      expect(result.sequencesTransferred).toBe(2);
      expect(result.stylesTransferred).toBe(1);

      // Verify team ownership transferred
      const team = await getTeamById(anonymousTeamId);
      expect(team).toBeDefined();
      expect(team?.members).toBeDefined();
      expect(team?.members[0]?.userId).toBe(authenticatedUserId);
    });
  });

  describe("Merge into existing team", () => {
    test("should merge anonymous data into authenticated user's team", async () => {
      // Create a new anonymous user
      const newAnonymousUserId = "00000000-0000-0000-0000-000000000012";
      const newAuthenticatedUserId = "00000000-0000-0000-0000-000000000013";

      // Create anonymous team with content
      const anonTeam = await createTeamWithOwner(
        {
          name: "Anon Team 2",
          slug: `anon-team-2-${Date.now()}`,
        },
        newAnonymousUserId
      );

      await createSequence({
        teamId: anonTeam.id,
        title: "Anon Sequence",
        status: "draft",
      });

      // Create authenticated user's team
      const authTeam = await createTeamWithOwner(
        {
          name: "Auth Team",
          slug: `auth-team-${Date.now()}`,
        },
        newAuthenticatedUserId
      );

      // Perform migration
      const result = await transferAnonymousUserData(
        newAnonymousUserId,
        newAuthenticatedUserId
      );

      expect(result.migrationType).toBe("merge");
      expect(result.targetTeamId).toBe(authTeam.id);
      expect(result.sequencesTransferred).toBe(1);

      // Verify anonymous team was deleted
      const deletedTeam = await getTeamById(anonTeam.id);
      expect(deletedTeam).toBeUndefined();

      // Verify content moved to authenticated team
      const authTeamWithContent = await getTeamById(authTeam.id);
      expect(authTeamWithContent).toBeDefined();
    });
  });
});

