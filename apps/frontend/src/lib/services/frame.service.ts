/**
 * Frame Service Layer
 *
 * Handles all frame-related business logic including CRUD operations,
 * frame generation orchestration, and reordering. This service contains
 * pure business logic with no authentication checks (caller's responsibility).
 *
 * @module lib/services/frame.service
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import type {
  Database,
  Frame,
  FrameInsert,
  FrameUpdate,
  Json,
} from "@/types/database";

// Type definitions
export interface CreateFrameParams {
  sequenceId: string;
  description: string;
  orderIndex: number;
  thumbnailUrl?: string;
  videoUrl?: string;
  durationMs?: number;
  metadata?: Json;
}

export interface UpdateFrameParams {
  id: string;
  description?: string;
  orderIndex?: number;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  durationMs?: number | null;
  metadata?: Json | null;
}

export interface GenerateFramesParams {
  sequenceId: string;
  userId: string;
  options?: {
    framesPerScene?: number;
    generateThumbnails?: boolean;
    generateDescriptions?: boolean;
    aiProvider?: "openai" | "anthropic" | "openrouter";
    regenerateAll?: boolean;
  };
}

export interface FrameGenerationResult {
  frameCount: number;
  jobId?: string;
  message: string;
}

/**
 * Frame Service Class
 *
 * Provides business logic for frame operations. All methods assume
 * the caller has already verified authentication and authorization.
 */
export class FrameService {
  constructor(
    private supabase: SupabaseClient<Database> = createServerClient(),
  ) {}

  /**
   * Create a new frame
   *
   * @param params - Frame creation parameters
   * @throws {Error} If database operation fails
   * @returns The created frame
   */
  async createFrame(params: CreateFrameParams): Promise<Frame> {
    const frameData: FrameInsert = {
      sequence_id: params.sequenceId,
      description: params.description,
      order_index: params.orderIndex,
      thumbnail_url: params.thumbnailUrl,
      video_url: params.videoUrl,
      duration_ms: params.durationMs,
      metadata: params.metadata,
    };

    const { data, error } = await this.supabase
      .from("frames")
      .insert(frameData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create frame: ${error.message}`);
    }

    if (!data) {
      throw new Error("No frame returned from database");
    }

    return data;
  }

  /**
   * Update an existing frame
   *
   * @param params - Frame update parameters
   * @throws {ValidationError} If frame not found
   * @throws {Error} If database operation fails
   * @returns The updated frame
   */
  async updateFrame(params: UpdateFrameParams): Promise<Frame> {
    const updateData: FrameUpdate = {
      ...(params.description !== undefined && {
        description: params.description,
      }),
      ...(params.orderIndex !== undefined && {
        order_index: params.orderIndex,
      }),
      ...(params.thumbnailUrl !== undefined && {
        thumbnail_url: params.thumbnailUrl,
      }),
      ...(params.videoUrl !== undefined && { video_url: params.videoUrl }),
      ...(params.durationMs !== undefined && {
        duration_ms: params.durationMs,
      }),
      ...(params.metadata !== undefined && { metadata: params.metadata }),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from("frames")
      .update(updateData)
      .eq("id", params.id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update frame: ${error.message}`);
    }

    if (!data) {
      throw new ValidationError("Frame not found");
    }

    return data;
  }

  /**
   * Delete a frame
   *
   * @param frameId - The frame ID to delete
   * @throws {Error} If database operation fails
   * @returns The sequence ID of the deleted frame (for cache revalidation)
   */
  async deleteFrame(frameId: string): Promise<string> {
    // First get the frame to know its sequence_id
    const { data: frame } = await this.supabase
      .from("frames")
      .select("sequence_id")
      .eq("id", frameId)
      .single();

    const { error } = await this.supabase
      .from("frames")
      .delete()
      .eq("id", frameId);

    if (error) {
      throw new Error(`Failed to delete frame: ${error.message}`);
    }

    return frame?.sequence_id || "";
  }

  /**
   * Get a single frame by ID
   *
   * @param frameId - The frame ID
   * @throws {ValidationError} If frame not found
   * @throws {Error} If database operation fails
   * @returns The frame
   */
  async getFrame(frameId: string): Promise<Frame> {
    const { data, error } = await this.supabase
      .from("frames")
      .select("*")
      .eq("id", frameId)
      .single();

    if (error) {
      throw new Error(`Failed to get frame: ${error.message}`);
    }

    if (!data) {
      throw new ValidationError("Frame not found");
    }

    return data;
  }

  /**
   * Get all frames for a sequence
   *
   * @param sequenceId - The sequence ID
   * @throws {Error} If database operation fails
   * @returns Array of frames ordered by order_index
   */
  async getFramesBySequence(sequenceId: string): Promise<Frame[]> {
    const { data, error } = await this.supabase
      .from("frames")
      .select("*")
      .eq("sequence_id", sequenceId)
      .order("order_index", { ascending: true });

    if (error) {
      throw new Error(`Failed to get frames: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Reorder frames in a sequence
   *
   * @param sequenceId - The sequence ID
   * @param frameOrders - Array of frame IDs with their new order indexes
   * @throws {Error} If database operation fails
   */
  async reorderFrames(
    sequenceId: string,
    frameOrders: Array<{ id: string; order_index: number }>,
  ): Promise<void> {
    // Update all frames with their new order indexes
    const updates = frameOrders.map((frameOrder) =>
      this.supabase
        .from("frames")
        .update({ order_index: frameOrder.order_index })
        .eq("id", frameOrder.id)
        .eq("sequence_id", sequenceId),
    );

    const results = await Promise.all(updates);

    const errors = results.filter((result) => result.error);
    if (errors.length > 0) {
      throw new Error(
        `Failed to reorder frames: ${errors.map((e) => e.error?.message).join(", ")}`,
      );
    }
  }

  /**
   * Delete all frames for a sequence
   *
   * @param sequenceId - The sequence ID
   * @throws {Error} If database operation fails
   */
  async deleteFramesBySequence(sequenceId: string): Promise<void> {
    const { error } = await this.supabase
      .from("frames")
      .delete()
      .eq("sequence_id", sequenceId);

    if (error) {
      throw new Error(`Failed to delete frames: ${error.message}`);
    }
  }

  /**
   * Bulk insert frames
   *
   * @param frames - Array of frames to insert
   * @throws {Error} If database operation fails
   * @returns Array of inserted frames
   */
  async bulkInsertFrames(frames: FrameInsert[]): Promise<Frame[]> {
    const { data, error } = await this.supabase
      .from("frames")
      .insert(frames)
      .select();

    if (error) {
      // If we get a unique constraint violation, try upsert instead
      if (error.code === "23505" || error.message.includes("duplicate key")) {
        const { data: upsertedFrames, error: upsertError } = await this.supabase
          .from("frames")
          .upsert(frames, {
            onConflict: "sequence_id,order_index",
            ignoreDuplicates: false,
          })
          .select();

        if (upsertError) {
          throw new Error(`Failed to upsert frames: ${upsertError.message}`);
        }

        return upsertedFrames || [];
      }

      throw new Error(`Failed to insert frames: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Update frame with thumbnail URL
   *
   * @param frameId - The frame ID
   * @param thumbnailUrl - The thumbnail URL
   * @throws {Error} If database operation fails
   */
  async updateFrameThumbnail(
    frameId: string,
    thumbnailUrl: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("frames")
      .update({ thumbnail_url: thumbnailUrl })
      .eq("id", frameId);

    if (error) {
      throw new Error(`Failed to update frame thumbnail: ${error.message}`);
    }
  }

  /**
   * Update frame with video URL
   *
   * @param frameId - The frame ID
   * @param videoUrl - The video URL
   * @throws {Error} If database operation fails
   */
  async updateFrameVideo(frameId: string, videoUrl: string): Promise<void> {
    const { error } = await this.supabase
      .from("frames")
      .update({ video_url: videoUrl })
      .eq("id", frameId);

    if (error) {
      throw new Error(`Failed to update frame video: ${error.message}`);
    }
  }
}

// Singleton instance
export const frameService = new FrameService();
