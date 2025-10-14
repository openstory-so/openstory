/**
 * FAL AI client for video and image generation
 * Provides integration with FAL's generative media models
 *
 * This file maintains backward compatibility while providing enhanced
 * service layer integration for new implementations.
 */

import { z } from "zod";
import {
  type FalImageModel,
  type FalVideoModel,
  IMAGE_MODELS,
  VIDEO_MODELS,
} from "@/lib/ai/models";
import type { FalServiceResponse } from "@/lib/fal/service";
import { getFalService } from "@/lib/fal/service";

// Response schema for FAL video generation
const falVideoResponseSchema = z.object({
  video: z.object({
    url: z.string().url(),
    content_type: z.string(),
    file_name: z.string(),
    file_size: z.number(),
  }),
  timings: z
    .object({
      inference: z.number(),
    })
    .optional(),
  seed: z.number().optional(),
});

// Response schema for FAL image generation
const falImageResponseSchema = z.object({
  images: z.array(
    z.object({
      url: z.string().url(),
      content_type: z.string().nullable().optional(),
      file_name: z.string().nullable().optional(),
      file_size: z.number().nullable().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
  timings: z
    .object({
      inference: z.number().optional(),
    })
    .optional(),
  seed: z.number().optional(),
  has_nsfw_concepts: z.array(z.boolean()).optional(),
  prompt: z.string().optional(),
});

export type FalVideoResponse = z.infer<typeof falVideoResponseSchema>;
export type FalImageResponse = z.infer<typeof falImageResponseSchema>;

// Import model definitions from separate file to avoid circular dependencies
export {
  type FalImageModel,
  type FalVideoModel,
  IMAGE_MODELS,
  VIDEO_MODELS,
} from "@/lib/ai/models";

/**
 * Parameters for video generation
 */
export interface FalVideoGenerationParams {
  model?: FalVideoModel;
  prompt?: string;
  image_url?: string; // For image-to-video models
  duration?: number; // Duration in seconds
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  enable_audio?: boolean; // For models that support audio
  seed?: number;
  // Service layer options
  userId?: string;
  teamId?: string;
  jobId?: string;
}

/**
 * Parameters for image generation
 */
export interface FalImageGenerationParams {
  model?: FalImageModel;
  prompt: string;
  image_size?:
    | "square_hd"
    | "square"
    | "portrait_4_3"
    | "portrait_16_9"
    | "landscape_4_3"
    | "landscape_16_9";
  num_images?: number;
  enable_safety_checker?: boolean;
  seed?: number;
  image_url?: string;
  // Service layer options
  userId?: string;
  teamId?: string;
  jobId?: string;
}

/**
 * Generate video using FAL AI with full service layer integration
 * Returns FalServiceResponse with usage tracking, cost info, and error handling
 */
export async function generateVideo(
  params: FalVideoGenerationParams,
): Promise<FalServiceResponse<FalVideoResponse>> {
  const apiKey = process.env.FAL_KEY;

  if (!apiKey) {
    console.warn(
      "[FAL] No API key found, using mock response. Set FAL_KEY environment variable.",
    );
    return {
      success: true,
      data: getMockVideoResponse(params),
      latencyMs: 15000,
      cost: 0,
    };
  }

  const falService = getFalService();
  const model = params.model || VIDEO_MODELS.minimax_hailuo;

  const requestData: Record<string, unknown> = {};

  // Add parameters based on model type
  if (params.prompt) requestData.prompt = params.prompt;
  if (params.image_url) requestData.image_url = params.image_url;
  if (params.duration) requestData.duration = params.duration;
  if (params.aspect_ratio) requestData.aspect_ratio = params.aspect_ratio;
  if (params.seed !== undefined) requestData.seed = params.seed;

  // Special handling for Veo3 which supports audio
  if (model === VIDEO_MODELS.veo3 && params.enable_audio !== undefined) {
    requestData.enable_audio = params.enable_audio;
  }

  const result = await falService.generateVideo(model, requestData, {
    userId: params.userId,
    teamId: params.teamId,
    jobId: params.jobId,
  });

  // Validate response data if successful
  if (result.success && result.data) {
    try {
      // Extract the actual data from the nested response structure
      const actualData =
        (result.data as Record<string, unknown>)?.data || result.data;
      const validatedData = falVideoResponseSchema.parse(actualData);
      return {
        ...result,
        data: validatedData,
      } as FalServiceResponse<FalVideoResponse>;
    } catch (validationError) {
      console.error("[FAL] Response validation failed:", validationError);
      console.error(
        "[FAL] Actual response structure:",
        JSON.stringify(result.data, null, 2),
      );
      return {
        success: false,
        error: "Invalid response format from Fal.ai",
        latencyMs: result.latencyMs,
        cost: result.cost,
      };
    }
  }

  return result as FalServiceResponse<FalVideoResponse>;
}

/**
 * Generate image using FAL AI with full service layer integration
 * Returns FalServiceResponse with usage tracking, cost info, and error handling
 */
export async function generateImage(
  params: FalImageGenerationParams,
): Promise<FalServiceResponse<FalImageResponse>> {
  const apiKey = process.env.FAL_KEY;

  if (!apiKey) {
    console.warn(
      "[FAL] No API key found, using mock response. Set FAL_KEY environment variable.",
    );
    return {
      success: true,
      data: getMockImageResponse(params),
      latencyMs: 1000,
      cost: 0,
    };
  }

  const falService = getFalService();
  const model = params.model || IMAGE_MODELS.flux_krea_lora;

  const requestData: Record<string, unknown> = {
    prompt: params.prompt,
  };

  // Add optional parameters
  if (params.image_size) requestData.image_size = params.image_size;
  if (params.num_images) requestData.num_images = params.num_images;
  if (params.enable_safety_checker !== undefined) {
    requestData.enable_safety_checker = params.enable_safety_checker;
  }
  if (params.seed !== undefined) requestData.seed = params.seed;
  if (params.image_url) requestData.image_url = params.image_url;

  if (process.env.NODE_ENV !== "production") {
    const { prompt, image_url, ...rest } = requestData;
    const redacted = {
      ...rest,
      prompt: prompt ? "[redacted]" : undefined,
      image_url: image_url ? "[redacted]" : undefined,
    };
    console.debug("[FAL] Request data:", redacted);
  }

  const result = await falService.generateImage(model, requestData, {
    userId: params.userId,
    teamId: params.teamId,
    jobId: params.jobId,
  });

  // Validate response data if successful
  if (result.success && result.data) {
    try {
      // Extract the actual data from the nested response structure
      const actualData =
        (result.data as Record<string, unknown>)?.data || result.data;
      const validatedData = falImageResponseSchema.parse(actualData);
      return {
        ...result,
        data: validatedData,
      } as FalServiceResponse<FalImageResponse>;
    } catch (validationError) {
      console.error("[FAL] Response validation failed:", validationError);
      console.error(
        "[FAL] Actual response structure:",
        JSON.stringify(result.data, null, 2),
      );
      return {
        success: false,
        error: "Invalid response format from Fal.ai",
        latencyMs: result.latencyMs,
        cost: result.cost,
      };
    }
  }

  return result as FalServiceResponse<FalImageResponse>;
}

/**
 * Generate mock video response for testing
 */
function getMockVideoResponse(
  params: FalVideoGenerationParams,
): FalVideoResponse {
  // Use different sample videos based on a simple hash of the prompt/image
  const sampleVideos = [
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
  ];

  // Pick a video based on the input to get some variety
  const hashStr = params.prompt || params.image_url || "";
  const hashCode = hashStr
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const videoIndex = Math.abs(hashCode) % sampleVideos.length;

  return {
    video: {
      url: sampleVideos[videoIndex],
      content_type: "video/mp4",
      file_name: "generated_video.mp4",
      file_size: 5510872,
    },
    timings: {
      inference: 15000, // 15 seconds
    },
    seed: params.seed || Math.floor(Math.random() * 1000000),
  };
}

/**
 * Generate mock image response for testing
 */
function getMockImageResponse(
  params: FalImageGenerationParams,
): FalImageResponse {
  return {
    images: [
      {
        url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg",
        content_type: "image/jpeg",
        file_name: "generated_image.jpg",
        file_size: 780831,
        width: 1920,
        height: 1080,
      },
    ],
    timings: {
      inference: 3000, // 3 seconds
    },
    seed: params.seed || Math.floor(Math.random() * 1000000),
    prompt: params.prompt,
  };
}

/**
 * FAL client for direct API calls
 * Used when we need more control over specific model parameters
 *
 * Note: For better error handling, usage tracking, and monitoring,
 * use generateImage() or generateVideo() functions instead.
 */
export const fal = {
  async run(
    model: string,
    params: { input: Record<string, unknown> },
  ): Promise<unknown> {
    const apiKey = process.env.FAL_KEY;

    if (!apiKey) {
      console.warn("[FAL] No API key found, returning mock response");
      return getMockVideoResponse({});
    }

    // Determine route based on known model lists first, then simple heuristics
    const isKnownImage = Object.values(IMAGE_MODELS).includes(
      model as FalImageModel,
    );
    const isKnownVideo = Object.values(VIDEO_MODELS).includes(
      model as FalVideoModel,
    );
    const isImageHeuristic =
      !isKnownVideo && (model.includes("flux") || model.includes("sdxl"));

    if (isKnownImage || isImageHeuristic) {
      const result = await generateImage({
        model: (isKnownImage ? (model as FalImageModel) : undefined) as
          | FalImageModel
          | undefined,
        prompt: (params.input.prompt as string) || "",
        ...params.input,
      } as FalImageGenerationParams);
      if (result.success) return result.data;
      throw new Error(result.error || "Image generation failed");
    }

    const result = await generateVideo({
      model: (isKnownVideo ? (model as FalVideoModel) : undefined) as
        | FalVideoModel
        | undefined,
      prompt: (params.input.prompt as string) || "",
      ...params.input,
    } as FalVideoGenerationParams);
    if (result.success) return result.data;
    throw new Error(result.error || "Video generation failed");
  },
};

/**
 * Upload a file to FAL for use in generation
 */
export async function uploadToFal(
  file: Buffer | Blob,
  filename: string,
): Promise<string> {
  const apiKey = process.env.FAL_KEY;

  if (!apiKey) {
    console.warn("[FAL] No API key, returning mock URL");
    return "https://example.com/mock-upload.jpg";
  }

  const formData = new FormData();

  // Type guard to check if file is a Buffer
  if (Buffer.isBuffer(file)) {
    // Convert Buffer to Blob
    const uint8Array = new Uint8Array(file.length);
    for (let i = 0; i < file.length; i++) {
      uint8Array[i] = file[i];
    }
    const blob = new Blob([uint8Array]);
    formData.append("file", blob, filename);
  } else {
    // file is a Blob
    formData.append("file", file, filename);
  }

  const response = await fetch("https://fal.run/storage/upload", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`FAL upload error: ${response.status}`);
  }

  const data = await response.json();
  return data.url;
}

/**
 * Check the status of a Fal.ai request using the service layer
 */
export async function checkFalStatus(): Promise<FalServiceResponse> {
  const falService = getFalService();
  return falService.checkStatus();
}

/**
 * Calculate the estimated cost for a Fal.ai request
 */
export function calculateFalCost(
  model: FalImageModel | FalVideoModel,
  params: Record<string, unknown>,
): number {
  const falService = getFalService();
  return falService.calculateCost(model, params);
}

/**
 * Calculate the estimated time for a Fal.ai request
 */
export function calculateFalTime(
  model: FalImageModel | FalVideoModel,
  params: Record<string, unknown>,
): number {
  const falService = getFalService();
  return falService.calculateTime(model, params);
}
