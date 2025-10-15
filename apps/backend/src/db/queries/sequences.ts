import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import type { NewFrame, NewSequence } from "@/db/schema";
import { frames, sequences } from "@/db/schema";

/**
 * Sequence query helpers
 * Type-safe database operations for sequences and frames
 */

/**
 * Get sequence by ID with frames
 */
export async function getSequenceById(sequenceId: string) {
  return await db.query.sequences.findFirst({
    where: eq(sequences.id, sequenceId),
    with: {
      frames: {
        orderBy: [asc(frames.orderIndex)],
      },
      style: true,
      team: true,
    },
  });
}

/**
 * Get all sequences for a team
 */
export async function getTeamSequences(teamId: string) {
  return await db.query.sequences.findMany({
    where: eq(sequences.teamId, teamId),
    orderBy: [desc(sequences.createdAt)],
    with: {
      frames: {
        orderBy: [asc(frames.orderIndex)],
      },
      style: true,
    },
  });
}

/**
 * Create a new sequence
 */
export async function createSequence(data: NewSequence) {
  const [sequence] = await db.insert(sequences).values(data).returning();
  return sequence;
}

/**
 * Update sequence
 */
export async function updateSequence(
  sequenceId: string,
  data: Partial<NewSequence>,
) {
  const [sequence] = await db
    .update(sequences)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sequences.id, sequenceId))
    .returning();
  return sequence;
}

/**
 * Delete sequence (cascades to frames)
 */
export async function deleteSequence(sequenceId: string) {
  await db.delete(sequences).where(eq(sequences.id, sequenceId));
}

/**
 * Get frame by ID
 */
export async function getFrameById(frameId: string) {
  return await db.query.frames.findFirst({
    where: eq(frames.id, frameId),
    with: {
      sequence: true,
    },
  });
}

/**
 * Get all frames for a sequence
 */
export async function getSequenceFrames(sequenceId: string) {
  return await db.query.frames.findMany({
    where: eq(frames.sequenceId, sequenceId),
    orderBy: [asc(frames.orderIndex)],
  });
}

/**
 * Create a new frame
 */
export async function createFrame(data: NewFrame) {
  const [frame] = await db.insert(frames).values(data).returning();
  return frame;
}

/**
 * Create multiple frames in a transaction
 */
export async function createFrames(frameData: NewFrame[]) {
  return await db.insert(frames).values(frameData).returning();
}

/**
 * Update frame
 */
export async function updateFrame(frameId: string, data: Partial<NewFrame>) {
  const [frame] = await db
    .update(frames)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(frames.id, frameId))
    .returning();
  return frame;
}

/**
 * Delete frame
 */
export async function deleteFrame(frameId: string) {
  await db.delete(frames).where(eq(frames.id, frameId));
}

/**
 * Reorder frames in a sequence
 */
export async function reorderFrames(sequenceId: string, frameIds: string[]) {
  // Update order_index for each frame
  const updates = frameIds.map((frameId, index) =>
    db
      .update(frames)
      .set({ orderIndex: index, updatedAt: new Date() })
      .where(and(eq(frames.id, frameId), eq(frames.sequenceId, sequenceId))),
  );

  // Execute all updates in parallel
  await Promise.all(updates);
}

/**
 * Get next available order index for a sequence
 */
export async function getNextFrameOrderIndex(
  sequenceId: string,
): Promise<number> {
  const sequenceFrames = await db.query.frames.findMany({
    where: eq(frames.sequenceId, sequenceId),
    orderBy: [desc(frames.orderIndex)],
    limit: 1,
  });

  return sequenceFrames.length > 0 ? sequenceFrames[0]?.orderIndex + 1 : 0;
}
