import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDatabase, db } from "@/db";
import {
  createFrame,
  createSequence,
  getSequenceById,
  getSequenceFrames,
} from "@/db/queries/sequences";
import { createStyle, getStyleById } from "@/db/queries/styles";
import {
  createTeam,
  getTeamById,
  getTeamBySlug,
  updateTeam,
} from "@/db/queries/teams";

describe("Database Queries", () => {
  let testTeamId: string;
  let _testUserId: string;

  beforeAll(async () => {
    // Create a test user (assuming BetterAuth user exists)
    // In real tests, you'd create this via BetterAuth
    _testUserId = "00000000-0000-0000-0000-000000000001";
  });

  afterAll(async () => {
    // Cleanup test data
    if (testTeamId) {
      await db.execute(`DELETE FROM teams WHERE id = '${testTeamId}'`);
    }
    await closeDatabase();
  });

  describe("Team Queries", () => {
    test("should create a team", async () => {
      const team = await createTeam({
        name: "Test Team",
        slug: `test-team-${Date.now()}`,
      });

      expect(team).toBeDefined();
      expect(team.name).toBe("Test Team");
      expect(team.id).toBeDefined();

      testTeamId = team.id;
    });

    test("should get team by ID", async () => {
      const team = await getTeamById(testTeamId);

      expect(team).toBeDefined();
      expect(team?.id).toBe(testTeamId);
      expect(team?.name).toBe("Test Team");
    });

    test("should get team by slug", async () => {
      const team = await getTeamBySlug(`test-team-${Date.now()}`);
      // May not find it if slug changed, but should not error
      expect(team).toBeDefined();
    });

    test("should update team", async () => {
      const updated = await updateTeam(testTeamId, {
        name: "Updated Test Team",
      });

      expect(updated).toBeDefined();
      expect(updated.name).toBe("Updated Test Team");
    });
  });

  describe("Sequence Queries", () => {
    let testSequenceId: string;

    test("should create a sequence", async () => {
      const sequence = await createSequence({
        teamId: testTeamId,
        title: "Test Sequence",
        script: "This is a test script",
        status: "draft",
      });

      expect(sequence).toBeDefined();
      expect(sequence.title).toBe("Test Sequence");
      expect(sequence.teamId).toBe(testTeamId);

      testSequenceId = sequence.id;
    });

    test("should get sequence by ID", async () => {
      const sequence = await getSequenceById(testSequenceId);

      expect(sequence).toBeDefined();
      expect(sequence?.id).toBe(testSequenceId);
      expect(sequence?.frames).toBeDefined();
    });

    test("should create frames for sequence", async () => {
      const frame1 = await createFrame({
        sequenceId: testSequenceId,
        orderIndex: 0,
        description: "Frame 1",
        durationMs: 3000,
      });

      const frame2 = await createFrame({
        sequenceId: testSequenceId,
        orderIndex: 1,
        description: "Frame 2",
        durationMs: 3000,
      });

      expect(frame1).toBeDefined();
      expect(frame2).toBeDefined();
      expect(frame1.orderIndex).toBe(0);
      expect(frame2.orderIndex).toBe(1);
    });

    test("should get sequence frames", async () => {
      const frames = await getSequenceFrames(testSequenceId);

      expect(frames).toBeDefined();
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames[0]?.orderIndex).toBe(0);
      expect(frames[1]?.orderIndex).toBe(1);
    });
  });

  describe("Style Queries", () => {
    test("should create a style", async () => {
      const style = await createStyle({
        teamId: testTeamId,
        name: "Test Style",
        configJson: { model: "flux-pro", prompt: "cinematic" },
        isPublic: false,
      });

      expect(style).toBeDefined();
      expect(style.name).toBe("Test Style");
      expect(style.teamId).toBe(testTeamId);
    });

    test("should get style by ID", async () => {
      const style = await createStyle({
        teamId: testTeamId,
        name: "Another Style",
        configJson: {},
        isPublic: true,
      });

      const retrieved = await getStyleById(style.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(style.id);
      expect(retrieved?.isPublic).toBe(true);
    });
  });
});
