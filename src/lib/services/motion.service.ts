/**
 * Motion Generation Service
 * Handles image-to-video generation using various AI models
 */

import type { Json } from "@/types/database";

// Model configurations with pricing and performance characteristics
export const MOTION_MODELS = {
  "svd-lcm": {
    provider: "fal",
    model: "fal-ai/fast-svd-lcm",
    name: "Fast Motion (SVD-LCM)",
    duration: 5, // seconds to generate
    cost: 0.1, // per frame
    quality: "good",
    defaultDuration: 2, // seconds of output video
    defaultFps: 7,
    maxDuration: 4,
    minFps: 7,
    maxFps: 15,
  },
  "stable-video": {
    provider: "fal",
    model: "fal-ai/stable-video-diffusion",
    name: "Balanced Motion (Stable Video)",
    duration: 15, // seconds to generate
    cost: 0.25, // per frame
    quality: "better",
    defaultDuration: 3,
    defaultFps: 14,
    maxDuration: 5,
    minFps: 10,
    maxFps: 25,
  },
  animatediff: {
    provider: "fal",
    model: "fal-ai/animatediff",
    name: "Premium Motion (AnimateDiff)",
    duration: 30, // seconds to generate
    cost: 0.5, // per frame
    quality: "best",
    defaultDuration: 4,
    defaultFps: 25,
    maxDuration: 8,
    minFps: 15,
    maxFps: 30,
  },
} as const;

export type MotionModel = keyof typeof MOTION_MODELS;

interface GenerateMotionOptions {
  imageUrl: string;
  prompt?: string;
  model?: MotionModel;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  styleStack?: Json;
}

interface MotionResult {
  success: boolean;
  videoUrl?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

/**
 * Enhance prompt for motion generation based on frame context
 */
function enhanceMotionPrompt(
  basePrompt: string | undefined,
  styleStack: Json | undefined,
): string {
  let enhancedPrompt = basePrompt || "Create smooth, natural motion";

  // Add style-specific motion hints
  if (styleStack && typeof styleStack === "object") {
    const style = styleStack as Record<string, unknown>;

    // Add motion style hints based on the style stack
    if (style.genre === "action") {
      enhancedPrompt += ", dynamic camera movement, fast-paced action";
    } else if (style.genre === "drama") {
      enhancedPrompt += ", subtle movements, emotional expressions";
    } else if (style.genre === "sci-fi") {
      enhancedPrompt += ", futuristic motion, smooth transitions";
    }

    // Add mood-based motion
    if (style.mood === "tense") {
      enhancedPrompt += ", slow deliberate movements";
    } else if (style.mood === "exciting") {
      enhancedPrompt += ", energetic motion, quick cuts";
    } else if (style.mood === "peaceful") {
      enhancedPrompt += ", gentle flowing movements";
    }
  }

  // Add general motion quality hints
  enhancedPrompt +=
    ", maintain visual consistency, smooth transitions, professional cinematography";

  return enhancedPrompt;
}

/**
 * Generate motion for a single frame using Fal.ai
 */
export async function generateMotionForFrame(
  options: GenerateMotionOptions,
): Promise<MotionResult> {
  try {
    const modelKey = options.model || "svd-lcm";
    const modelConfig = MOTION_MODELS[modelKey];

    if (!modelConfig) {
      throw new Error(`Invalid model: ${modelKey}`);
    }

    // Prepare the enhanced prompt
    const enhancedPrompt = enhanceMotionPrompt(
      options.prompt,
      options.styleStack,
    );

    // Validate and set parameters
    const duration = Math.min(
      options.duration || modelConfig.defaultDuration,
      modelConfig.maxDuration,
    );
    const fps = Math.max(
      modelConfig.minFps,
      Math.min(options.fps || modelConfig.defaultFps, modelConfig.maxFps),
    );
    const motionBucket = options.motionBucket || 127; // 1-255, higher = more motion

    // Import Fal.ai client dynamically to avoid initialization issues
    const { fal } = await import("@/lib/ai/fal-client");

    // Call the appropriate Fal.ai model
    let result: unknown;

    switch (modelKey) {
      case "svd-lcm": {
        // Fast SVD-LCM model
        result = await fal.run(modelConfig.model, {
          input: {
            image_url: options.imageUrl,
            motion_bucket_id: motionBucket,
            cond_aug: 0.02, // Conditioning augmentation
            decoding_t: Math.round(duration * fps), // Number of frames
            video_length: Math.round(duration * fps),
            sizing_strategy: "maintain_aspect_ratio",
            frames_per_second: fps,
            seed: Math.floor(Math.random() * 1000000),
          },
        });
        break;
      }

      case "stable-video": {
        // Stable Video Diffusion model
        result = await fal.run(modelConfig.model, {
          input: {
            image_url: options.imageUrl,
            motion_bucket_id: motionBucket,
            cond_aug: 0.02,
            decoding_t: Math.round(duration * fps),
            video_length: Math.round(duration * fps),
            sizing_strategy: "maintain_aspect_ratio",
            frames_per_second: fps,
            seed: Math.floor(Math.random() * 1000000),
          },
        });
        break;
      }

      case "animatediff": {
        // AnimateDiff model (requires different parameters)
        result = await fal.run(modelConfig.model, {
          input: {
            prompt: enhancedPrompt,
            image_url: options.imageUrl,
            num_frames: Math.round(duration * fps),
            fps,
            guidance_scale: 7.5,
            num_inference_steps: 25,
            seed: Math.floor(Math.random() * 1000000),
          },
        });
        break;
      }

      default:
        throw new Error(`Unsupported model: ${modelKey}`);
    }

    // Extract video URL from result
    const videoUrl = (result as { video?: { url?: string } })?.video?.url;

    if (!videoUrl) {
      console.error("[Motion Service] No video URL in result:", result);
      throw new Error("No video URL returned from motion generation");
    }

    return {
      success: true,
      videoUrl,
      metadata: {
        model: modelConfig.model,
        duration,
        fps,
        motionBucket,
        totalFrames: Math.round(duration * fps),
        cost: modelConfig.cost,
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error("[Motion Service] Generation failed:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Motion generation failed",
    };
  }
}

/**
 * Select the best model based on requirements
 */
export function selectMotionModel(requirements: {
  speed?: "fast" | "balanced" | "quality";
  budget?: "low" | "medium" | "high";
  duration?: number;
}): MotionModel {
  const { speed = "balanced", budget = "medium" } = requirements;

  // Speed priority
  if (speed === "fast") {
    return "svd-lcm";
  }

  if (speed === "quality") {
    return budget === "high" ? "animatediff" : "stable-video";
  }

  // Balanced approach
  if (budget === "low") {
    return "svd-lcm";
  }

  if (budget === "high") {
    return "animatediff";
  }

  return "stable-video";
}

/**
 * Calculate estimated cost and time for motion generation
 */
export function estimateMotionGeneration(
  frameCount: number,
  model: MotionModel = "svd-lcm",
): {
  totalCost: number;
  totalTime: number; // in seconds
  perFrameCost: number;
  perFrameTime: number;
} {
  const modelConfig = MOTION_MODELS[model];

  return {
    totalCost: frameCount * modelConfig.cost,
    totalTime: frameCount * modelConfig.duration,
    perFrameCost: modelConfig.cost,
    perFrameTime: modelConfig.duration,
  };
}
