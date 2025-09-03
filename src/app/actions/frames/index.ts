"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import type { Frame, FrameInsert, FrameUpdate, Json } from "@/types/database";

// Schema definitions
const createFrameSchema = z.object({
  sequence_id: z.string().uuid(),
  description: z.string().min(1).max(1000),
  order_index: z.number().int().positive(),
  thumbnail_url: z.string().url().optional(),
  video_url: z.string().url().optional(),
  duration_ms: z.number().int().min(1).optional(),
  metadata: z.any().optional() as z.ZodType<Json | undefined>,
});

const updateFrameSchema = z.object({
  id: z.string().uuid(),
  description: z.string().min(1).max(1000).optional(),
  order_index: z.number().int().positive().optional(),
  thumbnail_url: z.string().url().nullable().optional(),
  video_url: z.string().url().nullable().optional(),
  duration_ms: z.number().int().min(1).nullable().optional(),
  metadata: z.any().nullable().optional() as z.ZodType<Json | null | undefined>,
});

const deleteFrameSchema = z.object({
  id: z.string().uuid(),
});

export type CreateFrameInput = z.infer<typeof createFrameSchema>;
export type UpdateFrameInput = z.infer<typeof updateFrameSchema>;
export type DeleteFrameInput = z.infer<typeof deleteFrameSchema>;

/**
 * Create a new frame for a sequence
 */
export async function createFrame(
  input: CreateFrameInput,
): Promise<{ success: boolean; frame?: Frame; error?: string }> {
  try {
    const validated = createFrameSchema.parse(input);
    const supabase = createServerClient();

    const frameData: FrameInsert = {
      sequence_id: validated.sequence_id,
      description: validated.description,
      order_index: validated.order_index,
      thumbnail_url: validated.thumbnail_url,
      video_url: validated.video_url,
      duration_ms: validated.duration_ms,
      metadata: validated.metadata,
    };

    const { data, error } = await supabase
      .from("frames")
      .insert(frameData)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(`/sequences/${validated.sequence_id}`);
    return {
      success: true,
      frame: data,
    };
  } catch (error) {
    console.error("Error creating frame:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create frame",
    };
  }
}

/**
 * Update an existing frame
 */
export async function updateFrame(
  input: UpdateFrameInput,
): Promise<{ success: boolean; frame?: Frame; error?: string }> {
  try {
    const validated = updateFrameSchema.parse(input);
    const supabase = createServerClient();

    const updateData: FrameUpdate = {
      ...(validated.description !== undefined && {
        description: validated.description,
      }),
      ...(validated.order_index !== undefined && {
        order_index: validated.order_index,
      }),
      ...(validated.thumbnail_url !== undefined && {
        thumbnail_url: validated.thumbnail_url,
      }),
      ...(validated.video_url !== undefined && {
        video_url: validated.video_url,
      }),
      ...(validated.duration_ms !== undefined && {
        duration_ms: validated.duration_ms,
      }),
      ...(validated.metadata !== undefined && {
        metadata: validated.metadata,
      }),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("frames")
      .update(updateData)
      .eq("id", validated.id)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    // Get sequence_id to revalidate the correct path
    if (data?.sequence_id) {
      revalidatePath(`/sequences/${data.sequence_id}`);
    }

    return {
      success: true,
      frame: data,
    };
  } catch (error) {
    console.error("Error updating frame:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to update frame",
    };
  }
}

/**
 * Delete a frame
 */
export async function deleteFrame(
  input: DeleteFrameInput,
): Promise<{ success: boolean; error?: string }> {
  try {
    const validated = deleteFrameSchema.parse(input);
    const supabase = createServerClient();

    // First get the frame to know its sequence_id for revalidation
    const { data: frame } = await supabase
      .from("frames")
      .select("sequence_id")
      .eq("id", validated.id)
      .single();

    const { error } = await supabase
      .from("frames")
      .delete()
      .eq("id", validated.id);

    if (error) {
      throw new Error(error.message);
    }

    // Revalidate the sequence page if we found the sequence_id
    if (frame?.sequence_id) {
      revalidatePath(`/sequences/${frame.sequence_id}`);
    }

    return {
      success: true,
    };
  } catch (error) {
    console.error("Error deleting frame:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete frame",
    };
  }
}

/**
 * Get all frames for a sequence
 */
export async function getFramesBySequence(
  sequenceId: string,
): Promise<{ success: boolean; frames?: Frame[]; error?: string }> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("frames")
      .select("*")
      .eq("sequence_id", sequenceId)
      .order("order_index", { ascending: true });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      frames: data || [],
    };
  } catch (error) {
    console.error("Error getting frames:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get frames",
    };
  }
}

/**
 * Get a single frame by ID
 */
export async function getFrame(
  frameId: string,
): Promise<{ success: boolean; frame?: Frame; error?: string }> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("frames")
      .select("*")
      .eq("id", frameId)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      frame: data,
    };
  } catch (error) {
    console.error("Error getting frame:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get frame",
    };
  }
}

/**
 * Reorder frames in a sequence
 */
export async function reorderFrames(
  sequenceId: string,
  frameOrders: Array<{ id: string; order_index: number }>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();

    // Update all frames with their new order indexes
    const updates = frameOrders.map((frame) =>
      supabase
        .from("frames")
        .update({ order_index: frame.order_index })
        .eq("id", frame.id)
        .eq("sequence_id", sequenceId),
    );

    const results = await Promise.all(updates);
    const hasError = results.some((result) => result.error);

    if (hasError) {
      throw new Error("Failed to reorder some frames");
    }

    revalidatePath(`/sequences/${sequenceId}`);
    return {
      success: true,
    };
  } catch (error) {
    console.error("Error reordering frames:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to reorder frames",
    };
  }
}

/**
 * Bulk create frames for a sequence
 */
export async function bulkCreateFrames(
  sequenceId: string,
  frames: Omit<CreateFrameInput, "sequence_id">[],
): Promise<{ success: boolean; frames?: Frame[]; error?: string }> {
  try {
    const supabase = createServerClient();

    const frameInserts: FrameInsert[] = frames.map((frame) => ({
      sequence_id: sequenceId,
      description: frame.description,
      order_index: frame.order_index,
      thumbnail_url: frame.thumbnail_url,
      video_url: frame.video_url,
      duration_ms: frame.duration_ms,
      metadata: frame.metadata,
    }));

    const { data, error } = await supabase
      .from("frames")
      .insert(frameInserts)
      .select();

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(`/sequences/${sequenceId}`);
    return {
      success: true,
      frames: data,
    };
  } catch (error) {
    console.error("Error bulk creating frames:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to bulk create frames",
    };
  }
}

/**
 * Delete all frames for a sequence
 */
export async function deleteFramesBySequence(
  sequenceId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();

    const { error } = await supabase
      .from("frames")
      .delete()
      .eq("sequence_id", sequenceId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(`/sequences/${sequenceId}`);
    return {
      success: true,
    };
  } catch (error) {
    console.error("Error deleting frames:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete frames",
    };
  }
}
