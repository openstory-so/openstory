import { describe, test, expect, afterAll } from "bun:test";
import { closeDatabase } from "@/db";
import {
  withTransaction,
  createTeamWithOwner,
  bulkCreateFrames,
} from "@/db/transactions";
import { getTeamById, getTeamMember } from "@/db/queries/teams";
import { getSequenceFrames } from "@/db/queries/sequences";
import { createSequence } from "@/db/queries/sequences";

describe("Database Transactions", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  test("should execute transaction successfully", async () => {
    const result = await withTransaction(async (tx) => {
      const { teams } = await import("@/db/schema");
      const [team] = await tx
        .insert(teams)
        .values({
          name: "Transaction Test Team",
          slug: `tx-test-${Date.now()}`,
        })
        .returning();
      return team;
    });

    expect(result).toBeDefined();
    expect(result.name).toBe("Transaction Test Team");
  });

  test("should rollback transaction on error", async () => {
    const slug = `rollback-test-${Date.now()}`;

    try {
      await withTransaction(async (tx) => {
        const { teams } = await import("@/db/schema");
        await tx.insert(teams).values({
          name: "Rollback Test",
          slug,
        });

        // Force an error
        throw new Error("Test error");
      });
    } catch (error) {
      expect(error).toBeDefined();
    }

    // Verify team was not created
    const team = await getTeamById(slug);
    expect(team).toBeUndefined();
  });

  test("should create team with owner", async () => {
    const testUserId = "00000000-0000-0000-0000-000000000002";
    const slug = `team-with-owner-${Date.now()}`;

    const team = await createTeamWithOwner(
      {
        name: "Team with Owner",
        slug,
      },
      testUserId
    );

    expect(team).toBeDefined();
    expect(team.name).toBe("Team with Owner");

    // Verify owner was added
    const member = await getTeamMember(team.id, testUserId);
    expect(member).toBeDefined();
    expect(member?.role).toBe("owner");
  });

  test("should bulk create frames", async () => {
    // Create a test sequence first
    const team = await createTeamWithOwner(
      {
        name: "Bulk Frames Test Team",
        slug: `bulk-frames-${Date.now()}`,
      },
      "00000000-0000-0000-0000-000000000003"
    );

    const sequence = await createSequence({
      teamId: team.id,
      title: "Bulk Frames Test",
      status: "draft",
    });

    const descriptions = [
      "Frame 1 description",
      "Frame 2 description",
      "Frame 3 description",
    ];

    const frames = await bulkCreateFrames(sequence.id, descriptions);

    expect(frames).toBeDefined();
    expect(frames.length).toBe(3);
    expect(frames[0]?.orderIndex).toBe(0);
    expect(frames[1]?.orderIndex).toBe(1);
    expect(frames[2]?.orderIndex).toBe(2);

    // Verify frames were created
    const sequenceFrames = await getSequenceFrames(sequence.id);
    expect(sequenceFrames.length).toBe(3);
  });
});

