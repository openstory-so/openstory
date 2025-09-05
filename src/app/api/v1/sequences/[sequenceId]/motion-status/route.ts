/**
 * API endpoint for checking motion generation status for a sequence
 * GET /api/v1/sequences/[sequenceId]/motion-status
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, ValidationError } from "@/lib/errors";
import { getJobManager } from "@/lib/qstash/job-manager";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
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
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all frames for the sequence
    const { data: frames, error: framesError } = await supabase
      .from("frames")
      .select("id, thumbnail_url, video_url, metadata, order_index")
      .eq("sequence_id", sequenceId)
      .order("order_index", { ascending: true });

    if (framesError || !frames) {
      return NextResponse.json(
        { error: "Failed to fetch frames" },
        { status: 500 },
      );
    }

    // Calculate motion generation status
    const totalFrames = frames.length;
    const framesWithThumbnails = frames.filter((f) => f.thumbnail_url).length;
    const framesWithVideos = frames.filter((f) => f.video_url).length;

    // Get status for each frame
    const jobManager = getJobManager();
    const frameStatuses = await Promise.all(
      frames.map(async (frame) => {
        const metadata = frame.metadata as Record<string, unknown> | null;
        const motionJobId = metadata?.motionJobId as string | undefined;
        const motionStatus = metadata?.motionStatus as string | undefined;

        let jobStatus = null;
        if (motionJobId) {
          try {
            const job = await jobManager.getJob(motionJobId);
            if (job) {
              jobStatus = job.status;
            }
          } catch {
            // Job might not exist
          }
        }

        return {
          frameId: frame.id,
          orderIndex: frame.order_index,
          hasThumbnail: !!frame.thumbnail_url,
          hasVideo: !!frame.video_url,
          motionStatus:
            motionStatus || (frame.video_url ? "completed" : "none"),
          jobStatus,
          motionJobId,
        };
      }),
    );

    // Calculate progress percentage
    const progressPercentage =
      totalFrames > 0 ? Math.round((framesWithVideos / totalFrames) * 100) : 0;

    // Determine overall status
    let overallStatus = "not_started";
    const inProgress = frameStatuses.some(
      (f) => f.motionStatus === "generating" || f.jobStatus === "running",
    );
    const hasAnyVideos = framesWithVideos > 0;
    const allCompleted =
      framesWithVideos === framesWithThumbnails && framesWithThumbnails > 0;

    if (allCompleted) {
      overallStatus = "completed";
    } else if (inProgress) {
      overallStatus = "in_progress";
    } else if (hasAnyVideos) {
      overallStatus = "partial";
    }

    return NextResponse.json({
      success: true,
      sequenceId,
      overallStatus,
      progressPercentage,
      stats: {
        totalFrames,
        framesWithThumbnails,
        framesWithVideos,
        framesInProgress: frameStatuses.filter(
          (f) => f.motionStatus === "generating",
        ).length,
        framesFailed: frameStatuses.filter((f) => f.motionStatus === "failed")
          .length,
      },
      frames: frameStatuses,
    });
  } catch (error) {
    const velroError = handleApiError(error);
    return NextResponse.json(
      { error: velroError.message },
      { status: velroError.statusCode },
    );
  }
}
