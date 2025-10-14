import { useMutation, useQuery } from "@tanstack/react-query";
import z from "zod";
import type { FalModelsRequest } from "@/lib/schemas/fal-request";

// Validation schemas for response
const falModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      name: z.string(),
      type: z.enum(["image", "video"]),
    }),
  ),
});

const generateImageByFalResponseSchema = z.object({
  jobId: z.string(),
  success: z.boolean(),
});

const estimateImageCostByFalResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    cost: z.number(),
    time: z.number(),
  }),
});

const generatedImageByJobIdResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    team_id: z.string().nullable(),
    user_id: z.string().nullable(),
    type: z.enum(["image", "video"]),
    status: z.enum(["pending", "completed", "failed"]),
    payload: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
});

// Query keys
export const falModelKeys = {
  all: ["fal-models"] as const,
  lists: () => [...falModelKeys.all, "list"] as const,
  generate: () => [...falModelKeys.all, "generate"] as const,
  generateStatus: (jobId: string) =>
    [...falModelKeys.all, "generate", jobId] as const,
  estimate: () => [...falModelKeys.all, "estimate"] as const,
};

// Fetch all FAL models function
async function fetchFalModels(params: FalModelsRequest) {
  const url = new URL("/api/v1/fal/models", window.location.origin);
  url.searchParams.set("type", params.type);
  if (typeof params.includeCosts === "boolean") {
    url.searchParams.set("includeCosts", String(params.includeCosts));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      "[hooks/use-fal-models/fetchFalModels] Failed to fetch FAL models",
    );
  }
  const data = await response.json();
  return falModelsResponseSchema.parse(data);
}

// Hook for generating image by FAL
export interface GenerateImageByFalRequest {
  sequence_id: string;
  frame_id: string;
  prompt: string;
  model: string;
  style_id?: string;
  extra_params: Record<string, unknown>;
}

async function generateImageByFal(params: GenerateImageByFalRequest) {
  const url = new URL("/api/v1/generates/image", window.location.origin);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(
      "[hooks/use-fal-models/generateImageByFal] Failed to generate image",
    );
  }
  const data = await response.json();
  return generateImageByFalResponseSchema.parse(data);
}

export function useGenerateImageByFal() {
  return useMutation<
    { jobId: string; success: boolean },
    Error,
    GenerateImageByFalRequest
  >({
    mutationFn: (params: GenerateImageByFalRequest) =>
      generateImageByFal(params),
  });
}

async function fetchGeneratedImageByJobId(id: string) {
  const url = new URL(
    `/api/v1/generates/image/${id}/status`,
    window.location.origin,
  );
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      "[hooks/use-fal-models/fetchGeneratedImageByJobId] Failed to fetch generated image by job ID",
    );
  }
  const data = await response.json();
  return generatedImageByJobIdResponseSchema.parse(data);
}

// Hook for listing FAL models
export function useFalModels(params: FalModelsRequest) {
  return useQuery({
    queryKey: [...falModelKeys.lists(), params.type, params.includeCosts],
    queryFn: () => fetchFalModels(params),
  });
}

// Hook for generating image by FAL
export function useGenerateImageStatusByJobId(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: falModelKeys.generateStatus(id),
    queryFn: () => fetchGeneratedImageByJobId(id),
    refetchInterval: (query) => {
      if (
        query.state.data?.data?.status === "completed" ||
        query.state.data?.data?.status === "failed"
      ) {
        return false;
      }
      return 2000;
    },
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false, // Prevent refetch on focus to avoid refresh token errors
  });
}

// fetch estimate image cost by FAL
async function fetchEstimateImageCostByFal(
  params: EstimateImageCostByFalRequest,
) {
  const url = new URL(
    "/api/v1/generation/image/estimate",
    window.location.origin,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(
      "[hooks/use-fal-models/fetchEstimateImageCostByFal] Failed to fetch estimate",
    );
  }
  const data = await response.json();
  return estimateImageCostByFalResponseSchema.parse(data);
}

// hook for estimating image cost by FAL
export interface EstimateImageCostByFalRequest {
  model: string;
  prompt: string;
  extra_params: Record<string, unknown>;
}

// Hook for estimating image cost by FAL
export function useEstimateImageCostByFal() {
  return useMutation<
    { success: boolean; data: { cost: number; time: number } },
    Error,
    EstimateImageCostByFalRequest
  >({
    mutationFn: (params: EstimateImageCostByFalRequest) =>
      fetchEstimateImageCostByFal(params),
  });
}
