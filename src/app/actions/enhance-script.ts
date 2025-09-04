"use server";

import { headers } from "next/headers";
import { z } from "zod";
import {
  type EnhanceScriptOptions,
  enhanceScript as enhanceScriptService,
  scriptEnhancementRateLimiter,
} from "@/lib/ai/script-enhancer";

// Form data validation schema
const EnhanceScriptFormSchema = z.object({
  script: z
    .string()
    .min(10, "Script must be at least 10 characters")
    .max(10000, "Script too long"),
  targetDuration: z.number().min(15).max(60).optional(),
  tone: z.enum(["dramatic", "comedic", "documentary", "action"]).optional(),
  style: z.string().optional(),
});

export interface ScriptEnhancementResult {
  success: boolean;
  originalScript?: string;
  enhancedScript?: string;
  styleStackRecommendation?: {
    recommended_style_stack: string;
    reasoning: string;
  };
  error?: string;
  rateLimitInfo?: {
    isRateLimited: boolean;
    remainingTimeMs?: number;
  };
}

/**
 * Server action to enhance a script using AI
 */
export async function enhanceScript(
  formData: FormData,
): Promise<ScriptEnhancementResult> {
  try {
    // Get client IP for rate limiting
    const headersList = await headers();
    const forwardedFor = headersList.get("x-forwarded-for");
    const realIP = headersList.get("x-real-ip");
    const clientIP = forwardedFor?.split(",")[0] || realIP || "anonymous";

    // Check rate limiting
    if (!scriptEnhancementRateLimiter.isAllowed(clientIP)) {
      const remainingTimeMs =
        scriptEnhancementRateLimiter.getRemainingTime(clientIP);
      return {
        success: false,
        error: `Rate limit exceeded. Please try again in ${Math.ceil(remainingTimeMs / 1000)} seconds.`,
        rateLimitInfo: {
          isRateLimited: true,
          remainingTimeMs,
        },
      };
    }

    // Extract and process form data
    const script = formData.get("script") as string;
    const targetDurationStr = formData.get("targetDuration") as string;
    const tone = formData.get("tone") as string;
    const style = formData.get("style") as string;

    // Process optional fields
    const processedData = {
      script,
      targetDuration: targetDurationStr ? Number(targetDurationStr) : undefined,
      tone: tone || undefined,
      style: style || undefined,
    };

    // Validate the processed data
    const validatedData = EnhanceScriptFormSchema.parse(processedData);

    // Prepare options for the AI service
    const options: EnhanceScriptOptions = {
      originalScript: validatedData.script,
      targetDuration: validatedData.targetDuration,
      tone: validatedData.tone,
      style: validatedData.style || undefined,
    };

    // Call the AI service
    const result = await enhanceScriptService(options);

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to enhance script",
      };
    }

    if (!result.data) {
      return {
        success: false,
        error: "No enhanced script data received",
      };
    }

    // Log token usage for monitoring (in production, you might want to send to analytics)
    if (result.tokenUsage) {
      console.log(`Script enhancement token usage:`, {
        clientIP: `${clientIP.substring(0, 8)}...`, // Log partial IP for privacy
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
        totalTokens: result.tokenUsage.totalTokens,
        originalScriptLength: validatedData.script.length,
        enhancedScriptLength: result.data.enhanced_script.length,
      });
    }

    return {
      success: true,
      originalScript: validatedData.script,
      enhancedScript: result.data.enhanced_script,
      styleStackRecommendation: result.data.style_stack_recommendation,
      rateLimitInfo: {
        isRateLimited: false,
      },
    };
  } catch (error) {
    console.error("Enhance script server action error:", error);

    // Handle validation errors
    if (error instanceof z.ZodError) {
      const fieldErrors = error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ");

      return {
        success: false,
        error: `Validation error: ${fieldErrors}`,
      };
    }

    // Handle other errors
    if (error instanceof Error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: false,
      error: "An unexpected error occurred while enhancing the script.",
    };
  }
}

/**
 * Simple server action version for direct usage (without FormData)
 */
export async function enhanceScriptDirect(
  script: string,
  options?: {
    targetDuration?: number;
    tone?: "dramatic" | "comedic" | "documentary" | "action";
    style?: string;
  },
): Promise<ScriptEnhancementResult> {
  // Create FormData from parameters
  const formData = new FormData();
  formData.append("script", script);

  if (options?.targetDuration) {
    formData.append("targetDuration", options.targetDuration.toString());
  }
  if (options?.tone) {
    formData.append("tone", options.tone);
  }
  if (options?.style) {
    formData.append("style", options.style);
  }

  return enhanceScript(formData);
}
