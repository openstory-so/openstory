import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDatabase, db } from "@/db";
import { addTeamMember } from "@/db/queries/teams";
import { createTeamWithOwner } from "@/db/transactions";
import { AuthorizationError } from "@/plugins/error";
import type { User } from "../config";
import {
  getUserTeamRole,
  hasRole,
  isTeamMember,
  requireTeamAdmin,
  requireTeamMember,
  requireTeamOwner,
} from "../rbac";

describe("RBAC Utilities", () => {
  let testTeamId: string;
  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  let viewerUserId: string;
  let nonMemberUserId: string;

  beforeAll(async () => {
    // Create test users (mock user IDs)
    ownerUserId = "00000000-0000-0000-0000-000000000001";
    adminUserId = "00000000-0000-0000-0000-000000000002";
    memberUserId = "00000000-0000-0000-0000-000000000003";
    viewerUserId = "00000000-0000-0000-0000-000000000004";
    nonMemberUserId = "00000000-0000-0000-0000-000000000005";

    // Create team with owner
    const team = await createTeamWithOwner(
      {
        name: "RBAC Test Team",
        slug: `rbac-test-${Date.now()}`,
      },
      ownerUserId,
    );

    testTeamId = team.id;

    // Add other members with different roles
    await addTeamMember({
      teamId: testTeamId,
      userId: adminUserId,
      role: "admin",
    });

    await addTeamMember({
      teamId: testTeamId,
      userId: memberUserId,
      role: "member",
    });

    await addTeamMember({
      teamId: testTeamId,
      userId: viewerUserId,
      role: "viewer",
    });
  });

  afterAll(async () => {
    // Cleanup
    if (testTeamId) {
      await db.execute(`DELETE FROM teams WHERE id = '${testTeamId}'`);
    }
    await closeDatabase();
  });

  describe("hasRole", () => {
    test("should return true for exact role match", () => {
      expect(hasRole("admin", "admin")).toBe(true);
    });

    test("should return true for higher role", () => {
      expect(hasRole("owner", "admin")).toBe(true);
      expect(hasRole("admin", "member")).toBe(true);
      expect(hasRole("member", "viewer")).toBe(true);
    });

    test("should return false for lower role", () => {
      expect(hasRole("viewer", "member")).toBe(false);
      expect(hasRole("member", "admin")).toBe(false);
      expect(hasRole("admin", "owner")).toBe(false);
    });
  });

  describe("getUserTeamRole", () => {
    test("should return owner role", async () => {
      const role = await getUserTeamRole(ownerUserId, testTeamId);
      expect(role).toBe("owner");
    });

    test("should return admin role", async () => {
      const role = await getUserTeamRole(adminUserId, testTeamId);
      expect(role).toBe("admin");
    });

    test("should return member role", async () => {
      const role = await getUserTeamRole(memberUserId, testTeamId);
      expect(role).toBe("member");
    });

    test("should return viewer role", async () => {
      const role = await getUserTeamRole(viewerUserId, testTeamId);
      expect(role).toBe("viewer");
    });

    test("should return null for non-member", async () => {
      const role = await getUserTeamRole(nonMemberUserId, testTeamId);
      expect(role).toBeNull();
    });
  });

  describe("isTeamMember", () => {
    test("should return true for team members", async () => {
      expect(await isTeamMember(ownerUserId, testTeamId)).toBe(true);
      expect(await isTeamMember(adminUserId, testTeamId)).toBe(true);
      expect(await isTeamMember(memberUserId, testTeamId)).toBe(true);
      expect(await isTeamMember(viewerUserId, testTeamId)).toBe(true);
    });

    test("should return false for non-members", async () => {
      expect(await isTeamMember(nonMemberUserId, testTeamId)).toBe(false);
    });
  });

  describe("requireTeamMember", () => {
    test("should return role for team members", async () => {
      const mockUser = { id: ownerUserId } as User;
      const role = await requireTeamMember(mockUser, testTeamId);
      expect(role).toBe("owner");
    });

    test("should throw AuthorizationError for non-members", async () => {
      const mockUser = { id: nonMemberUserId } as User;

      try {
        await requireTeamMember(mockUser, testTeamId);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).message).toContain(
          "do not have access",
        );
      }
    });
  });

  describe("requireTeamAdmin", () => {
    test("should allow admin", async () => {
      const mockUser = { id: adminUserId } as User;
      const role = await requireTeamAdmin(mockUser, testTeamId);
      expect(role).toBe("admin");
    });

    test("should allow owner", async () => {
      const mockUser = { id: ownerUserId } as User;
      const role = await requireTeamAdmin(mockUser, testTeamId);
      expect(role).toBe("owner");
    });

    test("should deny member", async () => {
      const mockUser = { id: memberUserId } as User;

      try {
        await requireTeamAdmin(mockUser, testTeamId);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).message).toContain(
          "requires admin",
        );
      }
    });

    test("should deny viewer", async () => {
      const mockUser = { id: viewerUserId } as User;

      try {
        await requireTeamAdmin(mockUser, testTeamId);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
      }
    });
  });

  describe("requireTeamOwner", () => {
    test("should allow owner", async () => {
      const mockUser = { id: ownerUserId } as User;
      const role = await requireTeamOwner(mockUser, testTeamId);
      expect(role).toBe("owner");
    });

    test("should deny admin", async () => {
      const mockUser = { id: adminUserId } as User;

      try {
        await requireTeamOwner(mockUser, testTeamId);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).message).toContain(
          "requires owner",
        );
      }
    });

    test("should deny member", async () => {
      const mockUser = { id: memberUserId } as User;

      try {
        await requireTeamOwner(mockUser, testTeamId);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
      }
    });
  });
});
