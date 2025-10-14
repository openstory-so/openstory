import { eq, and, or, desc } from "drizzle-orm";
import { db } from "@/db";
import { styles } from "@/db/schema";
import type { NewStyle } from "@/db/schema";

/**
 * Style query helpers
 * Type-safe database operations for Style Stacks
 */

/**
 * Get style by ID
 */
export async function getStyleById(styleId: string) {
  return await db.query.styles.findFirst({
    where: eq(styles.id, styleId),
    with: {
      team: true,
      creator: true,
    },
  });
}

/**
 * Get all styles for a team (including public styles)
 */
export async function getTeamStyles(teamId: string) {
  return await db.query.styles.findMany({
    where: or(eq(styles.teamId, teamId), eq(styles.isPublic, true)),
    orderBy: [desc(styles.createdAt)],
    with: {
      creator: true,
    },
  });
}

/**
 * Get public styles
 */
export async function getPublicStyles() {
  return await db.query.styles.findMany({
    where: eq(styles.isPublic, true),
    orderBy: [desc(styles.createdAt)],
    with: {
      creator: true,
    },
  });
}

/**
 * Create a new style
 */
export async function createStyle(data: NewStyle) {
  const [style] = await db.insert(styles).values(data).returning();
  return style;
}

/**
 * Update style
 */
export async function updateStyle(styleId: string, data: Partial<NewStyle>) {
  const [style] = await db
    .update(styles)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(styles.id, styleId))
    .returning();
  return style;
}

/**
 * Delete style
 */
export async function deleteStyle(styleId: string) {
  await db.delete(styles).where(eq(styles.id, styleId));
}

/**
 * Check if style belongs to team
 */
export async function isTeamStyle(styleId: string, teamId: string): Promise<boolean> {
  const style = await db.query.styles.findFirst({
    where: and(eq(styles.id, styleId), eq(styles.teamId, teamId)),
  });
  return !!style;
}

