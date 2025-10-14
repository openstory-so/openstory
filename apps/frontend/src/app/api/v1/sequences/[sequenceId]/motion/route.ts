/**
 * API endpoint for generating motion for all frames in a sequence
 * POST /api/v1/sequences/[sequenceId]/motion
 */

import { z } from "zod";
import { generateMotionAction } from "@/app/actions/frames";
import {
  createErrorResponse,
  createSuccessResponse,
  requireAuthenticatedUserForMotion,
} from "@/lib/auth/api-utils";
import { ValidationError } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";

// Request body schema
const requestSchema = z.object({
  model: z.enum(["svd-lcm", "stable-video", "animatediff"]).optional(),
  duration: z.number().min(1).max(10).optional(),
  fps: z.number().min(7).max(30).optional(),
  motionBucket: z.number().min(1).max(255).optional(),
  frameIds: z.array(z.string().uuid()).optional(), // Optional: specific frames to generate
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> },
) {
  try {
    const supabase = createServerClient();
    const { sequenceId } = await params;

    // Validate UUID
    const uuidSchema = z.string().uuid();
    try {
      uuidSchema.parse(sequenceId);
    } catch {
      throw new ValidationError("Invalid sequence ID format");
    }

    // Check authentication
    await requireAuthenticatedUserForMotion(request);

    // Parse and validate request body
    const body = await request.json();
    const validatedData = requestSchema.parse(body);

    // Get frames for the sequence
    let frameQuery = supabase
      .from("frames")
      .select("id, thumbnail_url, description, order_index")
      .eq("sequence_id", sequenceId)
      .order("order_index", { ascending: true });

    // Filter by specific frame IDs if provided
    if (validatedData.frameIds && validatedData.frameIds.length > 0) {
      frameQuery = frameQuery.in("id", validatedData.frameIds);
    }

    const { data: frames, error: framesError } = await frameQuery;

    if (framesError || !frames || frames.length === 0) {
      return createErrorResponse("No frames found for sequence", 404);
    }

    // Filter frames that have thumbnails
    const framesWithThumbnails = frames.filter((f) => f.thumbnail_url);

    if (framesWithThumbnails.length === 0) {
      return createErrorResponse("No frames with thumbnails found", 400);
    }

    // Generate motion for each frame
    const jobs = [];
    const errors = [];

    for (const frame of framesWithThumbnails) {
      const result = await generateMotionAction({
        frameId: frame.id,
        model: validatedData.model,
        duration: validatedData.duration,
        fps: validatedData.fps,
        motionBucket: validatedData.motionBucket,
      });

      if (result.success && result.jobId) {
        jobs.push({
          frameId: frame.id,
          jobId: result.jobId,
          orderIndex: frame.order_index,
        });
      } else {
        errors.push({
          frameId: frame.id,
          error: result.error || "Failed to start motion generation",
        });
      }
    }

    return createSuccessResponse(
      {
        sequenceId,
        totalFrames: frames.length,
        framesWithThumbnails: framesWithThumbnails.length,
        jobsStarted: jobs.length,
        jobs,
        errors: errors.length > 0 ? errors : undefined,
      },
      `Motion generation started for ${jobs.length} frames`,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return createErrorResponse(error.message, 400);
    }
    return createErrorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500,
    );
  }
}
