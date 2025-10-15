/**
 * Sequence service layer
 * Business logic for sequence operations
 */

import {
  createSequence,
  deleteSequence,
  getSequenceById,
  getTeamSequences,
  updateSequence,
} from "@/db/queries/sequences";
import type { User } from "@/lib/auth/config";
import { requireTeamAdmin, requireTeamMember } from "@/lib/auth/rbac";
import { NotFoundError } from "@/plugins/error";
import type {
  CreateSequenceInput,
  UpdateSequenceInput,
} from "@/schemas/sequences";

export class SequenceService {
  /**
   * Get sequence by ID
   * Requires team membership
   */
  static async getById(sequenceId: string, user: User) {
    const sequence = await getSequenceById(sequenceId);

    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    // Check team membership
    await requireTeamMember(user, sequence.teamId);

    return sequence;
  }

  /**
   * List sequences for a team
   * Requires team membership
   */
  static async listByTeam(teamId: string, user: User) {
    // Check team membership
    await requireTeamMember(user, teamId);

    return await getTeamSequences(teamId);
  }

  /**
   * Create a new sequence
   * Requires team membership
   */
  static async create(teamId: string, input: CreateSequenceInput, user: User) {
    // Check team membership
    await requireTeamMember(user, teamId);

    // Create sequence
    const sequence = await createSequence({
      teamId,
      title: input.title,
      script: input.script || null,
      status: "draft",
      styleId: input.styleId || null,
      metadata: input.metadata || {},
      createdBy: user.id,
      updatedBy: user.id,
    });

    return sequence;
  }

  /**
   * Update a sequence
   * Requires team membership
   */
  static async update(
    sequenceId: string,
    input: UpdateSequenceInput,
    user: User,
  ) {
    // Get sequence and check ownership
    const sequence = await getSequenceById(sequenceId);

    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    // Check team membership
    await requireTeamMember(user, sequence.teamId);

    // Update sequence
    const updated = await updateSequence(sequenceId, {
      title: input.title,
      script: input.script,
      status: input.status,
      styleId: input.styleId,
      metadata: input.metadata,
      updatedBy: user.id,
    });

    return updated;
  }

  /**
   * Delete a sequence
   * Requires team admin role
   */
  static async delete(sequenceId: string, user: User) {
    // Get sequence and check ownership
    const sequence = await getSequenceById(sequenceId);

    if (!sequence) {
      throw new NotFoundError("Sequence not found");
    }

    // Check team admin role
    await requireTeamAdmin(user, sequence.teamId);

    // Delete sequence (cascades to frames)
    await deleteSequence(sequenceId);

    return { success: true };
  }
}
