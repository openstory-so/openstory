"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getQStashClient } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";
import { createServerClient } from "@/lib/supabase/server";
import type { Frame, FrameInsert, FrameUpdate, Json } from "@/types/database";

// Helper function to revalidate all sequence-related pages
function revalidateSequencePages(sequenceId: string): void {
  revalidatePath(`/sequences/${sequenceId}`);
  revalidatePath(`/sequences/${sequenceId}/script`);
  revalidatePath(`/sequences/${sequenceId}/storyboard`);
}

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

const generateFramesSchema = z.object({
  sequenceId: z.string().uuid(),
  options: z
    .object({
      framesPerScene: z.number().min(1).max(10).optional(),
      generateThumbnails: z.boolean().optional(),
      generateDescriptions: z.boolean().optional(),
      aiProvider: z.enum(["openai", "anthropic", "openrouter"]).optional(),
      regenerateAll: z.boolean().optional(), // Default: true
    })
    .optional(),
});

const regenerateFrameSchema = z.object({
  frameId: z.string().uuid(),
  regenerateDescription: z.boolean().optional(),
  regenerateThumbnail: z.boolean().optional(),
});

const generateMotionSchema = z.object({
  frameId: z.string().uuid(),
  model: z.enum(["svd-lcm", "stable-video", "animatediff"]).optional(),
  duration: z.number().min(1).max(10).optional(),
  fps: z.number().min(7).max(30).optional(),
  motionBucket: z.number().min(1).max(255).optional(),
});

export type CreateFrameInput = z.infer<typeof createFrameSchema>;
export type UpdateFrameInput = z.infer<typeof updateFrameSchema>;
export type DeleteFrameInput = z.infer<typeof deleteFrameSchema>;
export type GenerateFramesInput = z.infer<typeof generateFramesSchema>;
export type RegenerateFrameInput = z.infer<typeof regenerateFrameSchema>;
export type GenerateMotionInput = z.infer<typeof generateMotionSchema>;

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

    revalidateSequencePages(validated.sequence_id);
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
      revalidateSequencePages(data.sequence_id);
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
      revalidateSequencePages(frame.sequence_id);
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

    revalidateSequencePages(sequenceId);
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

    revalidateSequencePages(sequenceId);
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

    revalidateSequencePages(sequenceId);
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

/**
 * Generate frames for a sequence using AI
 * Phase 1: Quick frame creation (synchronous)
 * Phase 2: Async image generation (queued jobs)
 */
export async function generateFramesAction(
  input: GenerateFramesInput,
): Promise<{
  success: boolean;
  jobId?: string;
  message?: string;
  error?: string;
  frameCount?: number;
}> {
  const validated = generateFramesSchema.parse(input);

  try {
    const supabase = createServerClient();

    // Get the current user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Verify sequence exists and get all required data
    const { data: sequence, error: sequenceError } = await supabase
      .from("sequences")
      .select("*, styles(*)")
      .eq("id", validated.sequenceId)
      .single();

    if (sequenceError || !sequence) {
      throw new Error("Sequence not found");
    }

    if (!sequence.script) {
      throw new Error("Sequence has no script");
    }

    if (!sequence.style_id) {
      throw new Error("Sequence has no style selected");
    }

    // Verify user has access to this sequence (through team membership)
    if (user) {
      const { data: member } = await supabase
        .from("team_members")
        .select("id")
        .eq("team_id", sequence.team_id)
        .eq("user_id", user.id)
        .single();

      if (!member) {
        throw new Error(
          "You don't have permission to generate frames for this sequence",
        );
      }
    }

    // Set sequence status to processing and store generation metadata
    const generationMetadata = {
      frameGeneration: {
        status: "processing",
        startedAt: new Date().toISOString(),
        expectedFrameCount: null, // Will be updated after script analysis
        completedFrameCount: 0,
        options: validated.options,
      },
    };

    await supabase
      .from("sequences")
      .update({
        status: "processing",
        metadata: {
          ...((sequence.metadata as Record<string, unknown>) || {}),
          ...generationMetadata,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", validated.sequenceId);

    // Import AI services dynamically to avoid circular dependencies
    const { analyzeScriptForFrames } = await import("@/lib/ai/script-analyzer");
    const { generateFrameDescriptions } = await import(
      "@/lib/ai/frame-generator"
    );

    // PHASE 1: Quick frame creation (synchronous)
    console.log(
      "[generateFramesAction] Phase 1: Analyzing script and creating frames",
    );

    // Step 1: Analyze script to determine frame boundaries
    const scriptAnalysis = await analyzeScriptForFrames(
      sequence.script,
      validated.options?.aiProvider,
    );

    if (!scriptAnalysis?.scenes || scriptAnalysis.scenes.length === 0) {
      throw new Error("Failed to analyze script or no scenes found");
    }

    // Step 2: Generate frame descriptions for each scene
    const styleStack =
      sequence.styles && typeof sequence.styles === "object"
        ? (sequence.styles as { metadata?: unknown }).metadata
        : undefined;

    // This just takes the analysis and structures it into frames
    const frameDescriptions = await generateFrameDescriptions({
      scriptAnalysis,
      styleStack: styleStack as Json | undefined,
      aiProvider: validated.options?.aiProvider,
    });

    if (!frameDescriptions?.frames || frameDescriptions.frames.length === 0) {
      throw new Error("Failed to generate frame descriptions");
    }

    // Step 3: Handle existing frames
    const regenerateAll = validated.options?.regenerateAll !== false; // Default to true

    if (regenerateAll) {
      // Delete ALL existing frames for this sequence
      const { error: deleteError } = await supabase
        .from("frames")
        .delete()
        .eq("sequence_id", validated.sequenceId);

      if (deleteError) {
        console.warn(
          "[generateFramesAction] Failed to delete existing frames:",
          deleteError,
        );
      }
    }

    // Step 4: Insert the generated frames
    const framesToInsert: FrameInsert[] = frameDescriptions.frames.map(
      (frame) => ({
        sequence_id: validated.sequenceId,
        description: frame.description,
        order_index: frame.orderIndex,
        duration_ms: frame.durationMs,
        metadata: {
          ...frame.metadata,
          generatedAt: new Date().toISOString(),
          aiProvider: validated.options?.aiProvider || "openai",
        } as Json,
      }),
    );

    let insertedFrames: Array<Frame> | null = null;
    const { data: insertedFramesResult, error: insertError } = await supabase
      .from("frames")
      .insert(framesToInsert)
      .select();

    if (insertError) {
      // If we get a unique constraint violation, try upsert instead
      if (
        insertError.code === "23505" ||
        insertError.message.includes("duplicate key")
      ) {
        console.log("[generateFramesAction] Conflict detected, using upsert");

        const { data: upsertedFrames, error: upsertError } = await supabase
          .from("frames")
          .upsert(framesToInsert, {
            onConflict: "sequence_id,order_index",
            ignoreDuplicates: false,
          })
          .select();

        if (upsertError) {
          throw new Error(`Failed to upsert frames: ${upsertError.message}`);
        }

        insertedFrames = upsertedFrames;
      } else {
        throw new Error(`Failed to insert frames: ${insertError.message}`);
      }
    } else {
      insertedFrames = insertedFramesResult;
    }

    console.log("[generateFramesAction] Frames created successfully", {
      count: insertedFrames?.length,
      sequenceId: validated.sequenceId,
    });

    // PHASE 2: Queue individual image generation jobs
    if (
      validated.options?.generateThumbnails !== false &&
      insertedFrames &&
      insertedFrames.length > 0
    ) {
      console.log(
        "[generateFramesAction] Phase 2: Queueing image generation for frames",
      );

      const jobManager = getJobManager();
      const qstashClient = getQStashClient();
      const imageGenerationPromises = [];

      for (const frame of insertedFrames) {
        // Skip frames without descriptions
        if (!frame.description) {
          continue;
        }

        // Create an image generation job for each frame
        const imageJob = await jobManager.createJob({
          type: "image",
          payload: {
            frameId: frame.id,
            sequenceId: validated.sequenceId,
            prompt: frame.description,
            model: "flux_schnell", // Use fast model for thumbnails
            image_size: "landscape_16_9",
            num_images: 1,
          },
          userId: user?.id,
          teamId: sequence.team_id,
        });

        // Queue the image generation job
        const imagePayload = {
          jobId: imageJob.id,
          type: "image" as const,
          userId: user?.id,
          teamId: sequence.team_id,
          data: {
            frameId: frame.id,
            sequenceId: validated.sequenceId,
            prompt: frame.description,
            model: "flux_schnell",
            image_size: "landscape_16_9" as const,
            num_images: 1,
            // Add style information if available
            style: styleStack as Json | undefined,
          },
        };

        imageGenerationPromises.push(
          qstashClient
            .publishImageJob(imagePayload, {
              delay: 0, // Process immediately
            })
            .then((response) => {
              console.log("[generateFramesAction] Image job queued", {
                frameId: frame.id,
                imageJobId: imageJob.id,
                messageId: response.messageId,
              });
              return { frameId: frame.id, imageJobId: imageJob.id };
            }),
        );
      }

      // Wait for all image jobs to be queued
      try {
        await Promise.all(imageGenerationPromises);
        console.log("[generateFramesAction] All image generation jobs queued", {
          count: imageGenerationPromises.length,
        });
      } catch (error) {
        console.error(
          "[generateFramesAction] Failed to queue some image jobs",
          error,
        );
        // Don't fail the entire operation if image queueing fails
      }
    }

    // Update sequence status and metadata - frames are created, images may still be generating
    const { data: currentSequence } = await supabase
      .from("sequences")
      .select("metadata, status")
      .eq("id", validated.sequenceId)
      .single();

    const finalMetadata = {
      ...((currentSequence?.metadata as Record<string, unknown>) || {}),
      frameGeneration: {
        status:
          validated.options?.generateThumbnails !== false
            ? "generating_thumbnails"
            : "completed",
        startedAt:
          ((
            (currentSequence?.metadata as Record<string, unknown>)
              ?.frameGeneration as Record<string, unknown>
          )?.startedAt as string) || new Date().toISOString(),
        completedAt:
          validated.options?.generateThumbnails !== false
            ? null
            : new Date().toISOString(),
        expectedFrameCount: insertedFrames?.length || 0,
        completedFrameCount: insertedFrames?.length || 0,
        thumbnailsGenerating: validated.options?.generateThumbnails !== false,
      },
      lastFrameGeneration: {
        generatedAt: new Date().toISOString(),
        frameCount: insertedFrames?.length || 0,
        totalDuration: frameDescriptions.totalDuration,
      },
    };

    // Set status to draft if thumbnails are still generating, completed if not
    const newStatus =
      validated.options?.generateThumbnails !== false ? "draft" : "completed";

    await supabase
      .from("sequences")
      .update({
        status: newStatus,
        metadata: finalMetadata as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", validated.sequenceId);

    revalidateSequencePages(validated.sequenceId);

    return {
      success: true,
      jobId: `frames-${validated.sequenceId}-${Date.now()}`, // Add a jobId for tracking
      message: `${insertedFrames?.length || 0} frames created successfully. ${
        validated.options?.generateThumbnails !== false
          ? "Image generation is in progress."
          : ""
      }`,
      frameCount: insertedFrames?.length || 0,
    };
  } catch (error) {
    console.error("Error generating frames:", error);

    // Try to reset the sequence status on error
    try {
      const supabase = createServerClient();
      const { data: currentMeta } = await supabase
        .from("sequences")
        .select("metadata")
        .eq("id", validated.sequenceId)
        .single();

      const updatedMetadata = {
        ...((currentMeta?.metadata as Record<string, unknown>) || {}),
        frameGeneration: {
          status: "failed",
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Unknown error",
        },
      };

      await supabase
        .from("sequences")
        .update({
          status: "draft",
          metadata: updatedMetadata as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", validated.sequenceId);

      revalidateSequencePages(validated.sequenceId);
    } catch (updateError) {
      console.error(
        "Failed to update sequence status after error:",
        updateError,
      );
    }

    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate frames",
    };
  }
}

/**
 * Regenerate a single frame
 */
export async function regenerateFrameAction(
  input: RegenerateFrameInput,
): Promise<{
  success: boolean;
  jobId?: string;
  error?: string;
}> {
  try {
    const validated = regenerateFrameSchema.parse(input);
    const supabase = createServerClient();

    // Get the frame and sequence info
    const { data: frame, error: frameError } = await supabase
      .from("frames")
      .select("*, sequences!inner(id, team_id, script)")
      .eq("id", validated.frameId)
      .single();

    if (frameError || !frame) {
      throw new Error("Frame not found");
    }

    // Get the current user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Verify user has access (through team membership)
    if (user) {
      const { data: member } = await supabase
        .from("team_members")
        .select("id")
        .eq("team_id", frame.sequences.team_id)
        .eq("user_id", user.id)
        .single();

      if (!member) {
        throw new Error("You don't have permission to regenerate this frame");
      }
    }

    // Create a job for regeneration
    const jobManager = getJobManager();
    const job = await jobManager.createJob({
      type: "frame_generation",
      payload: {
        frameId: validated.frameId,
        sequenceId: frame.sequence_id,
        regenerateDescription: validated.regenerateDescription ?? true,
        regenerateThumbnail: validated.regenerateThumbnail ?? false,
      },
      userId: user?.id,
      teamId: frame.sequences.team_id,
    });

    // Update frame metadata with regeneration status
    await supabase
      .from("frames")
      .update({
        metadata: {
          ...(frame.metadata as Record<string, unknown>),
          regenerationJobId: job.id,
          status: "regenerating",
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", validated.frameId);

    revalidateSequencePages(frame.sequence_id);

    return {
      success: true,
      jobId: job.id,
    };
  } catch (error) {
    console.error("Error regenerating frame:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to regenerate frame",
    };
  }
}

/**
 * Get active frame generation job for a sequence
 */
export async function getActiveFrameGenerationJob(sequenceId: string): Promise<{
  success: boolean;
  job?: {
    id: string;
    type: string;
    status: string;
    progress?: number;
    result?: unknown;
    error?: string;
    created_at: string;
    updated_at: string;
    framesProgress?: {
      total: number;
      completed: number;
      frames: Array<{
        id: string;
        order_index: number;
        thumbnail_url?: string | null;
      }>;
    };
  };
  error?: string;
}> {
  try {
    const supabase = createServerClient();

    // Query for the most recent frame_generation job for this sequence
    // where status is pending or running
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("type", "frame_generation")
      .in("status", ["pending", "running"])
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(error.message);
    }

    if (!jobs || jobs.length === 0) {
      return {
        success: true,
        job: undefined,
      };
    }

    // Check if this job is for the requested sequence
    const job = jobs[0];
    const payload = job.payload as Record<string, unknown> | null;
    const jobSequenceId = payload?.sequenceId as string | undefined;

    if (jobSequenceId !== sequenceId) {
      return {
        success: true,
        job: undefined,
      };
    }

    // Get frame progress
    const { data: frames } = await supabase
      .from("frames")
      .select("id, order_index, thumbnail_url")
      .eq("sequence_id", sequenceId)
      .order("order_index", { ascending: true });

    const options = payload?.options as Record<string, unknown> | undefined;
    const framesPerScene = (options?.framesPerScene as number) || 3;

    return {
      success: true,
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: undefined,
        result: job.result,
        error: job.error || undefined,
        created_at: job.created_at,
        updated_at: job.updated_at,
        framesProgress: {
          total: framesPerScene,
          completed: frames?.filter((f) => f.thumbnail_url).length || 0,
          frames: frames || [],
        },
      },
    };
  } catch (error) {
    console.error("Error getting active job for sequence:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get active job",
    };
  }
}

/**
 * Generate motion (video) for a frame from its thumbnail
 */
export async function generateMotionAction(
  input: GenerateMotionInput,
): Promise<{
  success: boolean;
  jobId?: string;
  message?: string;
  error?: string;
}> {
  try {
    const validated = generateMotionSchema.parse(input);
    const supabase = createServerClient();

    // Get the frame with sequence info
    const { data: frame, error: frameError } = await supabase
      .from("frames")
      .select("*, sequences!inner(id, team_id, script, style_id, styles(*))")
      .eq("id", validated.frameId)
      .single();

    if (frameError || !frame) {
      throw new Error("Frame not found");
    }

    // Validate frame has thumbnail
    if (!frame.thumbnail_url) {
      throw new Error("Frame must have a thumbnail before generating motion");
    }

    // Get the current user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Verify user has access (through team membership)
    if (user) {
      const { data: member } = await supabase
        .from("team_members")
        .select("id")
        .eq("team_id", frame.sequences.team_id)
        .eq("user_id", user.id)
        .single();

      if (!member) {
        throw new Error(
          "You don't have permission to generate motion for this frame",
        );
      }
    }

    // Create a job for motion generation
    const jobManager = getJobManager();
    const job = await jobManager.createJob({
      type: "motion",
      payload: {
        frameId: validated.frameId,
        sequenceId: frame.sequence_id,
        thumbnailUrl: frame.thumbnail_url,
        prompt: frame.description,
        model: validated.model,
        duration: validated.duration,
        fps: validated.fps,
        motionBucket: validated.motionBucket,
      },
      userId: user?.id,
      teamId: frame.sequences.team_id,
    });

    // Queue the motion generation job
    const qstashClient = getQStashClient();
    const motionPayload = {
      jobId: job.id,
      type: "motion" as const,
      userId: user?.id,
      teamId: frame.sequences.team_id,
      data: {
        frameId: validated.frameId,
        sequenceId: frame.sequence_id,
        thumbnailUrl: frame.thumbnail_url,
        prompt: frame.description || undefined,
        model: validated.model || "svd-lcm", // Default to fast model
        duration: validated.duration || 2,
        fps: validated.fps || 7,
        motionBucket: validated.motionBucket || 127,
      },
    };

    const response = await qstashClient.publishMotionJob(motionPayload, {
      delay: 0, // Process immediately
    });

    console.log("[generateMotionAction] Motion job queued", {
      frameId: validated.frameId,
      jobId: job.id,
      messageId: response.messageId,
    });

    // Update frame metadata with motion generation status
    await supabase
      .from("frames")
      .update({
        metadata: {
          ...(frame.metadata as Record<string, unknown>),
          motionJobId: job.id,
          motionStatus: "generating",
          motionModel: validated.model || "svd-lcm",
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", validated.frameId);

    revalidateSequencePages(frame.sequence_id);

    return {
      success: true,
      jobId: job.id,
      message: "Motion generation started successfully",
    };
  } catch (error) {
    console.error("Error generating motion:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate motion",
    };
  }
}

/**
 * Get job status for frame generation
 */
export async function getFrameGenerationJobStatus(jobId: string): Promise<{
  success: boolean;
  job?: {
    id: string;
    type: string;
    status: string;
    progress?: number;
    result?: unknown;
    error?: string;
    created_at: string;
    updated_at: string;
    framesProgress?: {
      total: number;
      completed: number;
      frames: Array<{
        id: string;
        order_index: number;
        thumbnail_url?: string | null;
      }>;
    };
  };
  error?: string;
}> {
  try {
    const jobManager = getJobManager();
    const job = await jobManager.getJob(jobId);

    if (!job) {
      return {
        success: false,
        error: "Job not found",
      };
    }

    const supabase = createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Check if user has access to this job
    if (user && job.user_id && job.user_id !== user.id) {
      // Check if user is part of the same team
      if (job.team_id) {
        const { data: member } = await supabase
          .from("team_members")
          .select("id")
          .eq("team_id", job.team_id)
          .eq("user_id", user.id)
          .single();

        if (!member) {
          return {
            success: false,
            error: "Unauthorized",
          };
        }
      } else {
        return {
          success: false,
          error: "Unauthorized",
        };
      }
    }

    // If job is for frame generation, also check how many frames have been created
    let framesProgress:
      | {
          total: number;
          completed: number;
          frames: Array<{
            id: string;
            order_index: number;
            thumbnail_url?: string | null;
          }>;
        }
      | undefined;
    if (job.type === "frame_generation" && job.payload) {
      // Safely access the payload which is typed as Json
      const payload = job.payload as Record<string, unknown>;
      const sequenceId = payload.sequenceId as string | undefined;

      if (sequenceId) {
        const { data: frames } = await supabase
          .from("frames")
          .select("id, order_index, thumbnail_url")
          .eq("sequence_id", sequenceId)
          .order("order_index", { ascending: true });

        const options = payload.options as Record<string, unknown> | undefined;
        const framesPerScene = (options?.framesPerScene as number) || 3;

        framesProgress = {
          total: framesPerScene,
          completed: frames?.filter((f) => f.thumbnail_url).length || 0,
          frames: frames || [],
        };
      }
    }

    return {
      success: true,
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: undefined, // Job doesn't have a progress field in the database
        result: job.result,
        error: job.error || undefined,
        created_at: job.created_at,
        updated_at: job.updated_at,
        framesProgress,
      },
    };
  } catch (error) {
    console.error("Error getting job status:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get job status",
    };
  }
}
