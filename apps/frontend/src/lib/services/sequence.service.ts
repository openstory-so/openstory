/**
 * Sequence Service Layer
 *
 * Handles all sequence-related business logic including CRUD operations,
 * script analysis, and sequence management. This service contains pure
 * business logic with no authentication checks (caller's responsibility).
 *
 * @module lib/services/sequence.service
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import type {
  Database,
  Json,
  Sequence,
  SequenceInsert,
  SequenceStatus,
  SequenceUpdate,
} from "@/types/database";

// Type definitions
export interface CreateSequenceParams {
  teamId: string;
  userId: string;
  name: string;
  script: string;
  styleId?: string;
}

export interface UpdateSequenceParams {
  id: string;
  userId: string;
  name?: string;
  script?: string;
  styleId?: string | null;
  status?: SequenceStatus;
  metadata?: Json;
}

export interface SequenceWithDetails extends Sequence {
  frames?: Array<{
    id: string;
    order_index: number;
    description: string;
    thumbnail_url: string | null;
    video_url: string | null;
  }>;
}

/**
 * Sequence Service Class
 *
 * Provides business logic for sequence operations. All methods assume
 * the caller has already verified authentication and authorization.
 */
export class SequenceService {
  constructor(
    private supabase: SupabaseClient<Database> = createServerClient(),
  ) {}

  /**
   * Create a new sequence
   *
   * @param params - Sequence creation parameters
   * @throws {Error} If database operation fails
   * @returns The created sequence
   */
  async createSequence(params: CreateSequenceParams): Promise<Sequence> {
    const sequenceData: SequenceInsert = {
      team_id: params.teamId,
      created_by: params.userId,
      updated_by: params.userId,
      title: params.name,
      script: params.script,
      style_id: params.styleId,
      status: "draft",
    };

    const { data, error } = await this.supabase
      .from("sequences")
      .insert(sequenceData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create sequence: ${error.message}`);
    }

    if (!data) {
      throw new Error("No sequence returned from database");
    }

    return data;
  }

  /**
   * Update an existing sequence
   *
   * @param params - Sequence update parameters
   * @throws {ValidationError} If sequence not found
   * @throws {Error} If database operation fails
   * @returns The updated sequence
   */
  async updateSequence(params: UpdateSequenceParams): Promise<Sequence> {
    const updateData: SequenceUpdate = {
      ...(params.name !== undefined && { title: params.name }),
      ...(params.script !== undefined && { script: params.script }),
      ...(params.styleId !== undefined && { style_id: params.styleId }),
      ...(params.status !== undefined && { status: params.status }),
      ...(params.metadata !== undefined && { metadata: params.metadata }),
      updated_by: params.userId,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from("sequences")
      .update(updateData)
      .eq("id", params.id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update sequence: ${error.message}`);
    }

    if (!data) {
      throw new ValidationError("Sequence not found");
    }

    return data;
  }

  /**
   * Delete a sequence
   *
   * @param sequenceId - The sequence ID to delete
   * @throws {Error} If database operation fails
   */
  async deleteSequence(sequenceId: string): Promise<void> {
    const { error } = await this.supabase
      .from("sequences")
      .delete()
      .eq("id", sequenceId);

    if (error) {
      throw new Error(`Failed to delete sequence: ${error.message}`);
    }
  }

  /**
   * Get a single sequence by ID
   *
   * @param sequenceId - The sequence ID
   * @param includeFrames - Whether to include frames in the response
   * @throws {ValidationError} If sequence not found
   * @throws {Error} If database operation fails
   * @returns The sequence
   */
  async getSequence(
    sequenceId: string,
    includeFrames = false,
  ): Promise<SequenceWithDetails> {
    const query = this.supabase
      .from("sequences")
      .select(
        includeFrames
          ? "*, frames(id, order_index, description, thumbnail_url, video_url)"
          : "*",
      )
      .eq("id", sequenceId)
      .single();

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get sequence: ${error.message}`);
    }

    if (!data) {
      throw new ValidationError("Sequence not found");
    }

    return data as unknown as SequenceWithDetails;
  }

  /**
   * Get all sequences for a team
   *
   * @param teamId - The team ID
   * @throws {Error} If database operation fails
   * @returns Array of sequences
   */
  async getSequencesByTeam(teamId: string): Promise<Sequence[]> {
    const { data, error } = await this.supabase
      .from("sequences")
      .select("*")
      .eq("team_id", teamId)
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get sequences: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Get all sequences created by a user
   *
   * @param userId - The user ID
   * @throws {Error} If database operation fails
   * @returns Array of sequences
   */
  async getSequencesByUser(userId: string): Promise<Sequence[]> {
    const { data, error } = await this.supabase
      .from("sequences")
      .select("*")
      .eq("created_by", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get sequences: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Update sequence status
   *
   * @param sequenceId - The sequence ID
   * @param status - The new status
   * @throws {Error} If database operation fails
   */
  async updateSequenceStatus(
    sequenceId: string,
    status: SequenceStatus,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("sequences")
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sequenceId);

    if (error) {
      throw new Error(`Failed to update sequence status: ${error.message}`);
    }
  }

  /**
   * Update sequence metadata
   *
   * @param sequenceId - The sequence ID
   * @param metadata - The metadata to merge
   * @throws {Error} If database operation fails
   */
  async updateSequenceMetadata(
    sequenceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Get current metadata
    const { data: sequence } = await this.supabase
      .from("sequences")
      .select("metadata")
      .eq("id", sequenceId)
      .single();

    const currentMetadata =
      (sequence?.metadata as Record<string, unknown>) || {};

    const { error } = await this.supabase
      .from("sequences")
      .update({
        metadata: {
          ...currentMetadata,
          ...metadata,
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sequenceId);

    if (error) {
      throw new Error(`Failed to update sequence metadata: ${error.message}`);
    }
  }

  /**
   * Duplicate a sequence
   *
   * @param sequenceId - The sequence ID to duplicate
   * @param userId - The user ID creating the duplicate
   * @param newName - Optional new name for the duplicate
   * @throws {ValidationError} If sequence not found
   * @throws {Error} If database operation fails
   * @returns The duplicated sequence
   */
  async duplicateSequence(
    sequenceId: string,
    userId: string,
    newName?: string,
  ): Promise<Sequence> {
    // Get the original sequence
    const original = await this.getSequence(sequenceId);

    // Create a new sequence with the same data
    const duplicateData: SequenceInsert = {
      team_id: original.team_id,
      created_by: userId,
      updated_by: userId,
      title: newName || `${original.title} (Copy)`,
      script: original.script,
      style_id: original.style_id,
      status: "draft",
      metadata: original.metadata,
    };

    const { data, error } = await this.supabase
      .from("sequences")
      .insert(duplicateData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to duplicate sequence: ${error.message}`);
    }

    if (!data) {
      throw new Error("No sequence returned from database");
    }

    return data;
  }
}

// Singleton instance
export const sequenceService = new SequenceService();
