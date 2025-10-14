import {
  type GenerateImageInput,
  generateImageSchema,
} from "@/lib/ai/models-validation";
import { DNADirectorProcessor } from "@/lib/services/dna-director/dna-director.service";
import type { GeneratedImageStatusResponse } from "./types";

//  Generate image by Model
export async function generateImageByAction(
  input: GenerateImageInput,
): Promise<{
  success: boolean;
  jobId?: string;
  error?: string;
}> {
  try {
    const validated = generateImageSchema.parse(input);
    const params = {
      model: validated.model,
      sequence_id: validated.sequence_id,
      frame_id: validated.frame_id,
      prompt: validated.prompt,
      ...(validated.extra_params ?? {}),
    };

    // Apply DNA Director to the prompt
    if (validated.style_id) {
      const dnaDirectorResponse = await DNADirectorProcessor(
        validated.style_id,
        params.prompt,
      );
      if (dnaDirectorResponse.status) {
        params.prompt = dnaDirectorResponse.data?.message ?? params.prompt;
      } else {
        console.warn(
          "[generateImageByAction] DNA Director failed:",
          dnaDirectorResponse.error,
        );
      }
    }

    if (process.env.NODE_ENV !== "production")
      console.log(
        "[actions/generates/image] Generating image with model",
        validated.model,
        "and params",
        { ...params, prompt: "[REDACTED]" },
      );

    // Import QStash dependencies
    const { getJobManager } = await import("@/lib/qstash/job-manager");
    const { getQStashClient } = await import("@/lib/qstash/client");

    // Create a job for frame generation
    const jobManager = getJobManager();
    const job = await jobManager.createJob({
      type: "image",
      payload: params,
    });

    // Queue the frame generation job via QStash
    const qstashClient = getQStashClient();
    await qstashClient.publishImageJob({
      jobId: job.id,
      type: "image",
      data: params,
    });

    console.log("[actions/generates/image] Image generation job queued", {
      jobId: job.id,
    });

    return {
      success: true,
      jobId: job.id,
    };
  } catch (error) {
    console.error("[actions/generates/image] Error generating image", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate image",
    };
  }
}

//  Get generated image status by jobId
export async function fetchGeneratedImageStatusAction(jobId: string): Promise<{
  success: boolean;
  jobId?: string;
  error?: string;
  data?: GeneratedImageStatusResponse;
}> {
  const { createServerClient } = await import("@/lib/supabase/server");
  const supabase = createServerClient();

  const { data: jobData, error } = await supabase
    .from("jobs")
    .select(
      "team_id, user_id, type, status, payload, result, error, created_at, updated_at",
    )
    .eq("id", jobId)
    .single();

  if (error) {
    console.error("[actions/generates/image] Error fetching job status", error);
    return {
      success: false,
      error: "[actions/generates/image] Failed to fetch job status",
    };
  }

  console.log("[actions/generates/image] FAL generated image status by jobId", {
    jobData,
  });

  if (!jobData) {
    return {
      success: false,
      error: "[actions/generates/image] Record not found",
    };
  }

  return {
    success: true,
    jobId,
    data: jobData as unknown as GeneratedImageStatusResponse,
  };
}
