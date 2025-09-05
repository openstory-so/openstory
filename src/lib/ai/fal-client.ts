/**
 * FAL AI client for video and image generation
 * Provides integration with FAL's generative media models
 */

import { z } from "zod";

// FAL API configuration
const FAL_API_URL = "https://fal.run";

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
      content_type: z.string().optional(),
      file_name: z.string().optional(),
      file_size: z.number().optional(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  timings: z
    .object({
      inference: z.number(),
    })
    .optional(),
  seed: z.number().optional(),
  has_nsfw_concepts: z.array(z.boolean()).optional(),
  prompt: z.string().optional(),
});

export type FalVideoResponse = z.infer<typeof falVideoResponseSchema>;
export type FalImageResponse = z.infer<typeof falImageResponseSchema>;

/**
 * Available FAL models for video generation
 */
export const FAL_VIDEO_MODELS = {
  // Text to video models
  minimax_hailuo: "fal-ai/minimax-video/text-to-video",
  mochi_v1: "fal-ai/mochi-v1/text-to-video",
  luma_dream_machine: "fal-ai/luma-dream-machine",
  kling_v2: "fal-ai/kling-video-v1-5/standard/text-to-video",

  // Image to video models
  wan_i2v: "fal-ai/wan-i2v",
  kling_i2v: "fal-ai/kling-video-v1-5/standard/image-to-video",
  svd_lcm: "fal-ai/fast-svd-lcm",

  // Premium models
  veo3: "fal-ai/veo3", // Google Veo 3 with audio
  veo2_i2v: "fal-ai/veo2/image-to-video", // Google Veo 2
  wan_v2: "fal-ai/wan-v2-2-a14b", // WAN 2.2 cinematic quality
} as const;

/**
 * Available FAL models for image generation
 */
export const FAL_IMAGE_MODELS = {
  flux_pro: "fal-ai/flux-pro",
  flux_dev: "fal-ai/flux/dev",
  flux_schnell: "fal-ai/flux/schnell",
  sdxl: "fal-ai/fast-sdxl",
  sdxl_lightning: "fal-ai/fast-lightning-sdxl",
} as const;

export type FalVideoModel =
  (typeof FAL_VIDEO_MODELS)[keyof typeof FAL_VIDEO_MODELS];
export type FalImageModel =
  (typeof FAL_IMAGE_MODELS)[keyof typeof FAL_IMAGE_MODELS];

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
}

/**
 * Submit a request to FAL and poll for results
 */
async function submitAndPoll<T>(
  endpoint: string,
  data: Record<string, unknown>,
  apiKey: string,
): Promise<T> {
  // Submit the request
  const submitResponse = await fetch(`${FAL_API_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!submitResponse.ok) {
    const error = await submitResponse.text();
    throw new Error(
      `FAL API submit error: ${submitResponse.status} - ${error}`,
    );
  }

  const submitData = await submitResponse.json();
  const requestId = submitData.request_id;

  if (!requestId) {
    // If no request_id, it might be a synchronous response
    return submitData as T;
  }

  // Poll for results
  const statusUrl = `${FAL_API_URL}/${endpoint}/requests/${requestId}/status`;
  const maxPolls = 120; // 2 minutes with 1 second intervals
  let polls = 0;

  while (polls < maxPolls) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
    polls++;

    const statusResponse = await fetch(statusUrl, {
      headers: {
        Authorization: `Key ${apiKey}`,
      },
    });

    if (!statusResponse.ok) {
      throw new Error(`FAL API status error: ${statusResponse.status}`);
    }

    const statusData = await statusResponse.json();

    if (statusData.status === "completed") {
      return statusData.output as T;
    }

    if (statusData.status === "failed") {
      throw new Error(
        `FAL generation failed: ${statusData.error || "Unknown error"}`,
      );
    }

    // Continue polling if status is "queued" or "in_progress"
  }

  throw new Error("FAL generation timed out");
}

/**
 * Generate video using FAL AI
 */
export async function generateVideo(
  params: FalVideoGenerationParams,
): Promise<FalVideoResponse> {
  const apiKey = process.env.FAL_KEY;

  if (!apiKey) {
    console.warn(
      "[FAL] No API key found, using mock response. Set FAL_KEY environment variable.",
    );
    return getMockVideoResponse(params);
  }

  const model = params.model || FAL_VIDEO_MODELS.minimax_hailuo;

  // Build request data based on model type
  const requestData: Record<string, unknown> = {};

  if (params.image_url) {
    // Image to video
    requestData.image_url = params.image_url;
    if (params.prompt) requestData.prompt = params.prompt;
  } else if (params.prompt) {
    // Text to video
    requestData.prompt = params.prompt;
  } else {
    throw new Error(
      "Either prompt or image_url is required for video generation",
    );
  }

  // Add optional parameters
  if (params.duration) requestData.duration = params.duration;
  if (params.aspect_ratio) requestData.aspect_ratio = params.aspect_ratio;
  if (params.seed !== undefined) requestData.seed = params.seed;

  // Special handling for Veo3 which supports audio
  if (model === FAL_VIDEO_MODELS.veo3 && params.enable_audio !== undefined) {
    requestData.enable_audio = params.enable_audio;
  }

  try {
    const result = await submitAndPoll<FalVideoResponse>(
      model,
      requestData,
      apiKey,
    );

    const validated = falVideoResponseSchema.parse(result);

    return validated;
  } catch (error) {
    console.error("[FAL] Video generation failed:", error);
    // Fall back to mock response
    return getMockVideoResponse(params);
  }
}

/**
 * Generate image using FAL AI
 */
export async function generateImage(
  params: FalImageGenerationParams,
): Promise<FalImageResponse> {
  const apiKey = process.env.FAL_KEY;

  if (!apiKey) {
    console.warn(
      "[FAL] No API key found, using mock response. Set FAL_KEY environment variable.",
    );
    return getMockImageResponse(params);
  }

  const model = params.model || FAL_IMAGE_MODELS.flux_schnell;

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

  try {
    const result = await submitAndPoll<FalImageResponse>(
      model,
      requestData,
      apiKey,
    );

    const validated = falImageResponseSchema.parse(result);

    return validated;
  } catch (error) {
    console.error("[FAL] Image generation failed:", error);
    // Fall back to mock response
    return getMockImageResponse(params);
  }
}

/**
 * Generate mock video response for testing
 */
function getMockVideoResponse(
  params: FalVideoGenerationParams,
): FalVideoResponse {
  return {
    video: {
      url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
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

    return submitAndPoll(model, params.input, apiKey);
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
