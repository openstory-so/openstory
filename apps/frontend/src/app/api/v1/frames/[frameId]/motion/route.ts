/**
 * API endpoint for generating motion (video) from a frame's thumbnail
 * POST /api/v1/frames/[frameId]/motion
 */

import { z } from "zod";
import { generateMotionAction } from "@/app/actions/frames";
import {
  createErrorResponse,
  createSuccessResponse,
  requireAuth,
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
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ frameId: string }> },
) {
  try {
    const { frameId } = await params;

    // Validate UUID
    const uuidSchema = z.string().uuid();
    try {
      uuidSchema.parse(frameId);
    } catch {
      throw new ValidationError("Invalid frame ID format");
    }

    // Check authentication - Motion generation requires authenticated (non-anonymous) users
    await requireAuthenticatedUserForMotion(request);

    // Parse and validate request body
    const body = await request.json();
    const validatedData = requestSchema.parse(body);

    // Generate motion for the frame
    const result = await generateMotionAction({
      frameId,
      ...validatedData,
    });

    if (!result.success) {
      throw new Error(result.error || "Motion generation failed");
    }

    return createSuccessResponse(
      {
        jobId: result.jobId,
      },
      result.message || "Motion generation started",
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

// GET endpoint to check motion generation status
export async function GET(
  request: Request,
  { params }: { params: Promise<{ frameId: string }> },
) {
  try {
    const supabase = createServerClient();
    const { frameId } = await params;

    // Validate UUID
    const uuidSchema = z.string().uuid();
    try {
      uuidSchema.parse(frameId);
    } catch {
      throw new ValidationError("Invalid frame ID format");
    }

    // Check authentication
    await requireAuth(request);

    // Get frame with motion status
    const { data: frame, error } = await supabase
      .from("frames")
      .select("id, video_url, duration_ms, metadata")
      .eq("id", frameId)
      .single();

    if (error || !frame) {
      return createErrorResponse("Frame not found", 404);
    }

    const metadata = frame.metadata as Record<string, unknown> | null;
    const motionStatus = metadata?.motionStatus as string | undefined;
    const motionJobId = metadata?.motionJobId as string | undefined;
    const motionModel = metadata?.motionModel as string | undefined;

    return createSuccessResponse({
      frameId: frame.id,
      hasVideo: !!frame.video_url,
      videoUrl: frame.video_url,
      durationMs: frame.duration_ms,
      motionStatus: motionStatus || (frame.video_url ? "completed" : "none"),
      motionJobId,
      motionModel,
    });
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
