/**
 * Frame service layer
 * Business logic for frame operations
 */

import {
  getFrameById,
  getSequenceFrames,
  createFrame,
  updateFrame,
  deleteFrame,
  reorderFrames,
  getNextFrameOrderIndex,
} from "@/db/queries/sequences";
import { getSequenceById } from "@/db/queries/sequences";
import { requireTeamMember } from "@/lib/auth/rbac";
import type { User } from "@/lib/auth/config";
import type {
  CreateFrameInput,
  UpdateFrameInput,
  ReorderFramesInput,
} from "@/schemas/frames";
import { NotFoundError } from "@/plugins/error";

export class FrameService {
  /**
   * Get frame by ID
   * Requires team membership
   */
  static async getById(frameId: string, user: User) {
    const frame = await getFrameById(frameId);

    if (!frame) {
      throw new NotFoundError("Frame not found");
    }

    // Check team membership via sequence
    const sequence = await getSequenceById(frame.sequenceId);
    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    await requireTeamMember(user, sequence.teamId);

    return frame;
  }

  /**
   * List frames for a sequence
   * Requires team membership
   */
  static async listBySequence(sequenceId: string, user: User) {
    // Get sequence and check ownership
    const sequence = await getSequenceById(sequenceId);

    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    // Check team membership
    await requireTeamMember(user, sequence.teamId);

    return await getSequenceFrames(sequenceId);
  }

  /**
   * Create a new frame
   * Requires team membership
   */
  static async create(input: CreateFrameInput, user: User) {
    // Get sequence and check ownership
    const sequence = await getSequenceById(input.sequenceId);

    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    // Check team membership
    await requireTeamMember(user, sequence.teamId);

    // Get next order index if not provided
    const orderIndex =
      input.orderIndex ?? (await getNextFrameOrderIndex(input.sequenceId));

    // Create frame
    const frame = await createFrame({
      sequenceId: input.sequenceId,
      description: input.description,
      orderIndex,
      thumbnailUrl: input.thumbnailUrl || null,
      videoUrl: input.videoUrl || null,
      durationMs: input.durationMs || 3000,
      metadata: input.metadata || {},
    });

    return frame;
  }

  /**
   * Update a frame
   * Requires team membership
   */
  static async update(frameId: string, input: UpdateFrameInput, user: User) {
    // Get frame and check ownership
    const frame = await getFrameById(frameId);

    if (!frame) {
      throw new NotFoundError("Frame not found");
    }

    // Check team membership via sequence
    const sequence = await getSequenceById(frame.sequenceId);
    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    await requireTeamMember(user, sequence.teamId);

    // Update frame
    const updated = await updateFrame(frameId, {
      description: input.description,
      orderIndex: input.orderIndex,
      thumbnailUrl: input.thumbnailUrl,
      videoUrl: input.videoUrl,
      durationMs: input.durationMs,
      metadata: input.metadata,
    });

    return updated;
  }

  /**
   * Delete a frame
   * Requires team membership
   */
  static async delete(frameId: string, user: User) {
    // Get frame and check ownership
    const frame = await getFrameById(frameId);

    if (!frame) {
      throw new NotFoundError("Frame not found");
    }

    // Check team membership via sequence
    const sequence = await getSequenceById(frame.sequenceId);
    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    await requireTeamMember(user, sequence.teamId);

    // Delete frame
    await deleteFrame(frameId);

    return { success: true };
  }

  /**
   * Reorder frames in a sequence
   * Requires team membership
   */
  static async reorder(
    sequenceId: string,
    input: ReorderFramesInput,
    user: User
  ) {
    // Get sequence and check ownership
    const sequence = await getSequenceById(sequenceId);

    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    // Check team membership
    await requireTeamMember(user, sequence.teamId);

    // Reorder frames
    await reorderFrames(sequenceId, input.frameIds);

    return { success: true };
  }
}

