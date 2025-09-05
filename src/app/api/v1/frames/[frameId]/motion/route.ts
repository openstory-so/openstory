/**
 * API endpoint for generating motion (video) from a frame's thumbnail
 * POST /api/v1/frames/[frameId]/motion
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { generateMotionAction } from "@/app/actions/frames";
import { handleApiError, ValidationError } from "@/lib/errors";
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
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    return NextResponse.json(
      {
        success: true,
        jobId: result.jobId,
        message: result.message || "Motion generation started",
      },
      { status: 200 },
    );
  } catch (error) {
    const velroError = handleApiError(error);
    return NextResponse.json(
      { error: velroError.message },
      { status: velroError.statusCode },
    );
  }
}

// GET endpoint to check motion generation status
export async function GET(
  _request: Request,
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
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get frame with motion status
    const { data: frame, error } = await supabase
      .from("frames")
      .select("id, video_url, duration_ms, metadata")
      .eq("id", frameId)
      .single();

    if (error || !frame) {
      return NextResponse.json({ error: "Frame not found" }, { status: 404 });
    }

    const metadata = frame.metadata as Record<string, unknown> | null;
    const motionStatus = metadata?.motionStatus as string | undefined;
    const motionJobId = metadata?.motionJobId as string | undefined;
    const motionModel = metadata?.motionModel as string | undefined;

    return NextResponse.json({
      success: true,
      frameId: frame.id,
      hasVideo: !!frame.video_url,
      videoUrl: frame.video_url,
      durationMs: frame.duration_ms,
      motionStatus: motionStatus || (frame.video_url ? "completed" : "none"),
      motionJobId,
      motionModel,
    });
  } catch (error) {
    const velroError = handleApiError(error);
    return NextResponse.json(
      { error: velroError.message },
      { status: velroError.statusCode },
    );
  }
}
