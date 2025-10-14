import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, betterAuthUser } from "@/db/schema";
import type { NewUser } from "@/db/schema";

/**
 * User query helpers
 * Type-safe database operations for users
 */

/**
 * Get user by ID
 */
export async function getUserById(userId: string) {
  return await db.query.users.findFirst({
    where: eq(users.id, userId),
    with: {
      teamMemberships: {
        with: {
          team: true,
        },
      },
    },
  });
}

/**
 * Get BetterAuth user by ID
 */
export async function getBetterAuthUserById(userId: string) {
  return await db.query.betterAuthUser.findFirst({
    where: eq(betterAuthUser.id, userId),
  });
}

/**
 * Get BetterAuth user by email
 */
export async function getBetterAuthUserByEmail(email: string) {
  return await db.query.betterAuthUser.findFirst({
    where: eq(betterAuthUser.email, email),
  });
}

/**
 * Create user (Velro profile)
 */
export async function createUser(data: NewUser) {
  const [user] = await db.insert(users).values(data).returning();
  return user;
}

/**
 * Update user
 */
export async function updateUser(userId: string, data: Partial<NewUser>) {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return user;
}

/**
 * Delete user
 */
export async function deleteUser(userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

/**
 * Check if user is anonymous
 */
export async function isAnonymousUser(userId: string): Promise<boolean> {
  const user = await db.query.betterAuthUser.findFirst({
    where: eq(betterAuthUser.id, userId),
  });
  return user?.isAnonymous ?? false;
}

