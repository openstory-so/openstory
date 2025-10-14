"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MOTION_ACCESS_DENIED_MESSAGE } from "@/constants";
import { requireTeamMemberAccess, requireUser } from "@/lib/auth/action-utils";
import { createActionErrorResponse } from "@/lib/errors";
import { JobType } from "@/lib/qstash/job-manager";
import { sequenceService } from "@/lib/services/sequence.service";
import { createServerClient } from "@/lib/supabase/server";
import type { Frame, Json, Sequence } from "@/types/database";

// Helper function to revalidate all sequence-related pages
function revalidateSequencePages(sequenceId: string): void {
  revalidatePath(`/sequences/${sequenceId}`);
  revalidatePath(`/sequences/${sequenceId}/script`);
  revalidatePath(`/sequences/${sequenceId}/storyboard`);
}

// Schema definitions
const createSequenceSchema = z.object({
  name: z.string().min(1).max(100),
  script: z.string().min(10).max(10000),
  style_id: z.uuid().optional(),
});

const updateSequenceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100).optional(),
  script: z.string().min(10).max(10000).optional(),
  style_id: z.uuid().nullable().optional(),
});

export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;

/**
 * Create or update a sequence in the database
 */
export async function saveSequence(
  script: string,
  styleId: string | null,
  sequenceId?: string,
  name?: string,
): Promise<{ success: boolean; sequence?: Sequence; error?: string }> {
  try {
    const user = await requireUser();
    const supabase = createServerClient();

    let sequence: Sequence;

    if (sequenceId) {
      // Update existing sequence - verify team access
      const { data: existingSeq } = await supabase
        .from("sequences")
        .select("team_id")
        .eq("id", sequenceId)
        .single();

      if (existingSeq) {
        await requireTeamMemberAccess(user.id, existingSeq.team_id);
      }

      sequence = await sequenceService.updateSequence({
        id: sequenceId,
        userId: user.id,
        name: name || "Untitled Sequence",
        script,
        styleId,
      });
    } else {
      // Create new sequence - get user's team
      const { data: teamMemberships, error: teamError } = await supabase
        .from("team_members")
        .select("team_id, role")
        .eq("user_id", user.id)
        .order("role", { ascending: true })
        .limit(1);

      if (teamError || !teamMemberships || teamMemberships.length === 0) {
        throw new Error(
          "No team found for user. Please refresh the page to initialize your account.",
        );
      }

      const teamId = teamMemberships[0].team_id;

      sequence = await sequenceService.createSequence({
        teamId,
        userId: user.id,
        name: name || "Untitled Sequence",
        script,
        styleId: styleId || "",
      });
    }

    // The script and/or style may have changed, so regenerate frames
    await generateFrames(sequence.id);

    revalidateSequencePages(sequence.id);

    return {
      success: true,
      sequence,
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * Generate frames from script and save to database using AI
 * Creates a QStash job that triggers the frames webhook which calls generateFramesAction
 */
export async function generateFrames(sequenceId: string): Promise<{
  success: boolean;
  frames?: Frame[];
  jobId?: string;
  error?: string;
}> {
  try {
    const user = await requireUser();
    const supabase = createServerClient();

    // Verify sequence exists and get team info
    const { data: sequence } = await supabase
      .from("sequences")
      .select("id, team_id")
      .eq("id", sequenceId)
      .single();

    if (!sequence) {
      throw new Error("Sequence not found");
    }

    // Verify user has access to this sequence
    await requireTeamMemberAccess(user.id, sequence.team_id);

    // Import QStash dependencies
    const { getJobManager } = await import("@/lib/qstash/job-manager");
    const { getQStashClient } = await import("@/lib/qstash/client");

    // Check for existing active jobs to prevent duplicates
    const jobManager = getJobManager();
    const existingJobs = await jobManager.getJobsByStatus("running", {
      teamId: sequence.team_id,
    });

    // Check for existing frame generation job for this sequence
    const existingFrameJob = existingJobs.find((job) => {
      if (job.type !== "frame_generation") return false;
      const payload = job.payload as { sequenceId?: string };
      return payload?.sequenceId === sequenceId;
    });

    if (existingFrameJob) {
      console.log("[generateFrames] Found existing active job, returning it", {
        sequenceId,
        existingJobId: existingFrameJob.id,
      });
      return {
        success: true,
        jobId: existingFrameJob.id,
        frames: [],
      };
    }

    // Also check for pending jobs
    const pendingJobs = await jobManager.getJobsByStatus("pending", {
      teamId: sequence.team_id,
    });

    const existingPendingJob = pendingJobs.find((job) => {
      if (job.type !== "frame_generation") return false;
      const payload = job.payload as { sequenceId?: string };
      return payload?.sequenceId === sequenceId;
    });

    if (existingPendingJob) {
      console.log("[generateFrames] Found existing pending job, returning it", {
        sequenceId,
        existingJobId: existingPendingJob.id,
      });
      return {
        success: true,
        jobId: existingPendingJob.id,
        frames: [],
      };
    }

    // Create a job for frame generation
    const job = await jobManager.createJob({
      type: JobType.FRAME_GENERATION,
      payload: {
        sequenceId,
        options: {
          framesPerScene: 3, // Generate 3 frames per scene
          generateThumbnails: true,
          generateDescriptions: true,
          aiProvider: "openrouter", // Use OpenRouter for AI generation
          regenerateAll: true, // Delete existing frames before generating new ones
        },
      },
      userId: user.id,
      teamId: sequence.team_id,
    });

    // Queue the frame generation job via QStash
    const qstashClient = getQStashClient();
    await qstashClient.publishFrameGenerationJob({
      jobId: job.id,
      type: JobType.FRAME_GENERATION,
      userId: user.id,
      teamId: sequence.team_id,
      data: {
        sequenceId,
        options: {
          framesPerScene: 3,
          generateThumbnails: true,
          generateDescriptions: true,
          aiProvider: "openrouter",
          regenerateAll: true,
        },
      },
    });

    console.log("[generateFrames] Frame generation job queued", {
      sequenceId,
      jobId: job.id,
    });

    // Return success with job ID for tracking
    return {
      success: true,
      jobId: job.id,
      frames: [], // Frames will be populated asynchronously via QStash
    };
  } catch (error) {
    console.error("Error generating frames:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate frames",
    };
  }
}

/**
 * Generate motion for a frame and update in database
 */
export async function generateFrameMotion(
  frameId: string,
  frameDescription: string,
  styleId: string,
): Promise<{
  success: boolean;
  videoUrl?: string;
  duration?: number;
  error?: string;
}> {
  try {
    const user = await requireUser();

    // Block anonymous users from motion generation
    if (user.isAnonymous) {
      return {
        success: false,
        error: MOTION_ACCESS_DENIED_MESSAGE,
      };
    }

    const supabase = createServerClient();

    // Get the frame with sequence info to get team_id
    const { data: frame, error: frameError } = await supabase
      .from("frames")
      .select("*, sequences!inner(style_id, team_id)")
      .eq("id", frameId)
      .single();

    if (frameError || !frame) {
      throw new Error("Frame not found");
    }

    if (!frame.thumbnail_url) {
      throw new Error(
        "Frame must have a thumbnail image before generating motion",
      );
    }

    const teamId = frame.sequences.team_id;
    const sequenceId = frame.sequence_id;

    // Get style stack from the style
    const { data: style } = await supabase
      .from("styles")
      .select("config")
      .eq("id", styleId)
      .single();

    // Use the real motion service
    const { generateMotionForFrame } = await import(
      "@/lib/services/motion.service"
    );

    const result = await generateMotionForFrame({
      imageUrl: frame.thumbnail_url,
      prompt: frameDescription,
      model: "seedance_v1_pro", // Default to Seedance Pro for better quality output
      styleStack: style?.config || undefined,
      duration: 3, // 3 second videos
      fps: 14,
      motionBucket: 127, // Medium motion
    });

    let finalVideoUrl: string;
    let videoStoragePath: string | undefined;

    if (!result.success || !result.videoUrl) {
      // Fallback to mock for development if Fal.ai fails
      console.warn(
        "[generateFrameMotion] Real motion generation failed, using mock",
        result.error,
      );
      const { generateFrameMotion: generateMockMotion } = await import(
        "#actions/anonymous-flow"
      );
      const mockResult = await generateMockMotion(
        frameId,
        frameDescription,
        styleId,
      );

      if (!mockResult.success) {
        throw new Error(mockResult.error || "Failed to generate motion");
      }

      finalVideoUrl = mockResult.videoUrl;

      // Update frame with mock video URL
      const { data, error } = await supabase
        .from("frames")
        .update({
          video_url: mockResult.videoUrl,
          duration_ms: mockResult.duration,
          metadata: {
            ...(frame.metadata as object),
            motionGenerated: true,
            motionModel: "mock",
            motionDuration: mockResult.duration,
            videoStoragePath: null, // Mock videos aren't stored
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", frameId)
        .select()
        .single();

      if (error) {
        throw new Error(error.message);
      }

      revalidateSequencePages(data.sequence_id);
      return {
        success: true,
        videoUrl: mockResult.videoUrl,
        duration: mockResult.duration,
      };
    }

    // Store the FAL video in Supabase Storage for permanent access
    const { uploadVideoToStorage } = await import(
      "@/lib/services/video-storage.service"
    );

    const storageResult = await uploadVideoToStorage({
      videoUrl: result.videoUrl,
      teamId,
      sequenceId,
      frameId,
    });

    if (storageResult.success && storageResult.url) {
      finalVideoUrl = storageResult.url;
      videoStoragePath = storageResult.path;
      console.log(
        "[generateFrameMotion] Video stored in Supabase:",
        videoStoragePath,
      );
    } else {
      // If storage fails, use the temporary FAL URL
      console.warn(
        "[generateFrameMotion] Failed to store video, using FAL URL:",
        storageResult.error,
      );
      finalVideoUrl = result.videoUrl;
    }

    // Update frame with the stored video URL
    const { data, error } = await supabase
      .from("frames")
      .update({
        video_url: finalVideoUrl,
        duration_ms: ((result.metadata?.duration as number) || 3) * 1000,
        metadata: {
          ...(frame.metadata as object),
          motionGenerated: true,
          motionModel: (result.metadata?.model as string) || "svd-lcm",
          motionMetadata: result.metadata as Json | undefined,
          videoStoragePath,
          videoStoredAt: videoStoragePath ? new Date().toISOString() : null,
          falVideoUrl: result.videoUrl, // Keep original FAL URL for reference
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", frameId)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    revalidateSequencePages(data.sequence_id);
    return {
      success: true,
      videoUrl: finalVideoUrl,
      duration: ((result.metadata?.duration as number) || 3) * 1000,
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
 * Get a sequence by ID with all its frames
 */
export async function getSequence(sequenceId: string): Promise<{
  success: boolean;
  sequence?: Sequence & { frames: Frame[] };
  error?: string;
}> {
  try {
    const user = await requireUser();

    // Verify user has access to the sequence's team
    const supabase = createServerClient();
    const { data: seq } = await supabase
      .from("sequences")
      .select("team_id")
      .eq("id", sequenceId)
      .single();

    if (seq) {
      await requireTeamMemberAccess(user.id, seq.team_id);
    }

    const sequence = await sequenceService.getSequence(sequenceId, true);

    return {
      success: true,
      sequence: sequence as Sequence & { frames: Frame[] },
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * List all sequences for the current user's team
 */
export async function listSequences(): Promise<{
  success: boolean;
  sequences?: Sequence[];
  error?: string;
}> {
  try {
    const user = await requireUser();
    const supabase = createServerClient();

    // Get user's team
    const { data: membership } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      // No team membership yet, return empty array
      return {
        success: true,
        sequences: [],
      };
    }

    const sequences = await sequenceService.getSequencesByTeam(
      membership.team_id,
    );

    return {
      success: true,
      sequences,
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

// Legacy functions for backward compatibility with existing schema
export async function createSequence(input: CreateSequenceInput) {
  const validated = createSequenceSchema.parse(input);
  return saveSequence(
    validated.script,
    validated.style_id || null,
    undefined,
    validated.name,
  );
}

export async function updateSequence(input: UpdateSequenceInput) {
  const validated = updateSequenceSchema.parse(input);
  return saveSequence(
    validated.script || "",
    validated.style_id === undefined ? null : validated.style_id,
    validated.id,
    validated.name,
  );
}

/**
 * Delete a sequence (admin/owner only)
 */
export async function deleteSequence(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await requireUser();
    const supabase = createServerClient();

    // Get the sequence to verify team ownership
    const { data: sequence } = await supabase
      .from("sequences")
      .select("team_id")
      .eq("id", id)
      .single();

    if (!sequence) {
      return { success: false, error: "Sequence not found" };
    }

    // Require admin access to delete
    await requireTeamMemberAccess(user.id, sequence.team_id, "admin");

    // Delete the sequence (frames will be cascade deleted)
    await sequenceService.deleteSequence(id);

    // Revalidate sequence pages
    revalidatePath("/sequences");
    revalidatePath(`/sequences/${id}`);

    return { success: true };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

export async function generateStoryboard(sequenceId: string) {
  const sequenceResult = await getSequence(sequenceId);
  if (!sequenceResult.success || !sequenceResult.sequence) {
    throw new Error("Sequence not found");
  }

  const { script, style_id } = sequenceResult.sequence;
  if (!script || !style_id) {
    throw new Error("Sequence missing script or style");
  }

  return generateFrames(sequenceId);
}
