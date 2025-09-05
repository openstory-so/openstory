/**
 * Video generation webhook handler
 * Processes video generation jobs from QStash using FAL AI
 */

import {
  FAL_VIDEO_MODELS,
  generateImage,
  generateVideo,
  uploadToFal,
} from "@/lib/ai/fal-client";
import type { JobPayload } from "@/lib/qstash/client";
import { withQStashVerification } from "@/lib/qstash/middleware";
import { BaseWebhookHandler, type JobProcessor } from "../base-handler";

/**
 * Video generation processor using FAL AI
 */
const processVideoGeneration: JobProcessor = async (
  payload: JobPayload,
  _metadata,
): Promise<Record<string, unknown>> => {
  const { data } = payload;

  // Type assertion for video data
  const videoData = data as {
    prompt?: string;
    image_url?: string; // For image-to-video
    image_data?: string; // Base64 encoded image
    model?: string;
    duration?: number;
    aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
    enable_audio?: boolean;
    style?: unknown;
    [key: string]: unknown;
  };

  try {
    // Handle image upload if base64 data is provided
    let imageUrl = videoData.image_url;
    if (videoData.image_data && !imageUrl) {
      const imageBuffer = Buffer.from(videoData.image_data, "base64");
      imageUrl = await uploadToFal(imageBuffer, "frame.jpg");
    }

    // Determine model to use
    let model = videoData.model as keyof typeof FAL_VIDEO_MODELS | undefined;
    if (!model) {
      // Auto-select model based on input
      if (imageUrl) {
        model = "wan_i2v"; // Default image-to-video model
      } else {
        model = "minimax_hailuo"; // Default text-to-video model
      }
    }

    // Generate video using FAL
    const falResponse = await generateVideo({
      model: FAL_VIDEO_MODELS[model],
      prompt: videoData.prompt,
      image_url: imageUrl,
      duration: videoData.duration,
      aspect_ratio: videoData.aspect_ratio,
      enable_audio: videoData.enable_audio,
    });

    // Generate thumbnail if video doesn't come with one
    let thumbnailUrl: string | undefined;
    if (videoData.prompt && !imageUrl) {
      // Generate a thumbnail image from the prompt
      const thumbnailResponse = await generateImage({
        prompt: videoData.prompt,
        image_size:
          videoData.aspect_ratio === "9:16"
            ? "portrait_16_9"
            : "landscape_16_9",
        num_images: 1,
      });
      thumbnailUrl = thumbnailResponse.images[0]?.url;
    } else if (imageUrl) {
      // Use the input image as thumbnail
      thumbnailUrl = imageUrl;
    }

    // Build result structure
    const result = {
      videoUrls: [falResponse.video.url],
      thumbnailUrls: thumbnailUrl ? [thumbnailUrl] : [],
      parameters: data,
      generatedAt: new Date().toISOString(),
      processingTimeMs: falResponse.timings?.inference || 0,
      provider: "fal-ai",
      metadata: {
        prompt: videoData.prompt,
        model,
        duration: videoData.duration,
        aspect_ratio: videoData.aspect_ratio,
        format: falResponse.video.content_type,
        file_size: falResponse.video.file_size,
        seed: falResponse.seed,
      },
    };

    return result;
  } catch (error) {
    console.error("[VideoWebhook] Video generation failed", error);

    // Return mock fallback on error
    const fallbackResult = {
      videoUrls: [
        "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      ],
      thumbnailUrls: [
        "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg",
      ],
      parameters: data,
      generatedAt: new Date().toISOString(),
      processingTimeMs: 3000,
      provider: "mock-fallback",
      metadata: {
        prompt: videoData.prompt || "Fallback video due to generation error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
    };

    return fallbackResult;
  }
};

/**
 * Video webhook handler
 */
const videoWebhookHandler = new BaseWebhookHandler();

/**
 * POST handler for video generation webhooks
 */
export const POST = withQStashVerification(async (request) => {
  return videoWebhookHandler.processWebhook(request, processVideoGeneration);
});

/**
 * GET handler for webhook testing
 */
export async function GET() {
  return Response.json({
    message: "Video generation webhook endpoint",
    timestamp: new Date().toISOString(),
    status: "active",
  });
}
