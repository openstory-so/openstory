import OpenAI from "openai";
import { z } from "zod";

// Input validation schema
const EnhanceScriptOptionsSchema = z.object({
  originalScript: z
    .string()
    .min(1, "Script cannot be empty")
    .max(10000, "Script too long"),
  targetDuration: z.number().min(15).max(60).optional().default(30),
  tone: z
    .enum(["dramatic", "comedic", "documentary", "action"])
    .optional()
    .default("dramatic"),
  style: z.string().optional(),
});

// Output validation schema
const EnhancedScriptSchema = z.object({
  enhanced_script: z.string(),
  improvements_made: z.array(z.string()),
  estimated_duration: z.number(),
  scene_count: z.number(),
});

export interface EnhanceScriptOptions {
  originalScript: string;
  targetDuration?: number; // Default 30 seconds
  tone?: "dramatic" | "comedic" | "documentary" | "action";
  style?: string; // Optional style context
}

export interface EnhancedScript {
  enhanced_script: string;
  improvements_made: string[];
  estimated_duration: number;
  scene_count: number;
}

export interface ScriptEnhancementResult {
  success: boolean;
  data?: EnhancedScript;
  error?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Initialize OpenRouter client (lazy initialization to support testing)
let openrouter: OpenAI | null = null;

function getOpenRouterClient(): OpenAI {
  if (!openrouter) {
    openrouter = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY || "test-key",
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return openrouter;
}

// System prompt for script enhancement
const createSystemPrompt = (options: EnhanceScriptOptions): string => {
  const { targetDuration = 30, tone = "dramatic", style } = options;

  return `You are a professional screenwriter specializing in short-form video content. Your task is to enhance user-provided text into a compelling ${targetDuration}-second film script.

Guidelines:
- Target exactly ${targetDuration} seconds of screen time (approximately ${Math.floor(targetDuration * 2.5)} - ${Math.ceil(targetDuration * 3.3)} words)
- Create clear visual scenes with specific actions and descriptions
- Include emotional hooks and story beats appropriate for ${tone} tone
- Maintain the core message/theme from the original input
- Structure with proper scene transitions
- Focus on visual storytelling that works well for AI-generated imagery
- Include specific details about lighting, camera angles, and visual composition
${style ? `- Incorporate elements that complement the "${style}" visual style` : ""}

You must respond with a valid JSON object in the following format:
{
  "enhanced_script": "The enhanced script text",
  "improvements_made": ["List of specific improvements made"],
  "estimated_duration": number_of_seconds,
  "scene_count": number_of_distinct_scenes
}

Focus on creating scripts that are:
1. Visually compelling and specific
2. Emotionally engaging within the time constraint
3. Technically feasible for AI video generation
4. Structurally sound with clear beginning, middle, and end`;
};

// Create user prompt
const createUserPrompt = (originalScript: string): string => {
  return `Please enhance this script for a short film:

"${originalScript}"

Transform it into a professional, visually detailed script that tells a complete story within the target duration.`;
};

export async function enhanceScript(
  options: EnhanceScriptOptions,
): Promise<ScriptEnhancementResult> {
  try {
    // Validate input
    const validatedOptions = EnhanceScriptOptionsSchema.parse(options);

    // Check if OpenRouter API key is configured
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OpenRouter API key not configured");
    }

    // Create prompts
    const systemPrompt = createSystemPrompt(validatedOptions);
    const userPrompt = createUserPrompt(validatedOptions.originalScript);

    // Make API call to OpenRouter
    const client = getOpenRouterClient();
    const completion = await client.chat.completions.create({
      model: "anthropic/claude-3.5-sonnet",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      max_tokens: 1000,
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    const response = completion.choices[0]?.message?.content;

    if (!response) {
      throw new Error("No response received from AI service");
    }

    // Parse the JSON response
    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(response);
    } catch (parseError) {
      throw new Error(`Failed to parse AI response as JSON: ${parseError}`);
    }

    // Validate the parsed response structure
    const validatedResponse = EnhancedScriptSchema.parse(parsedResponse);

    // Extract token usage information
    const tokenUsage = completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        }
      : undefined;

    return {
      success: true,
      data: validatedResponse,
      tokenUsage,
    };
  } catch (error) {
    console.error("Script enhancement error:", error);

    // Handle different types of errors
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.issues.map((i) => i.message).join(", ")}`,
      };
    }

    if (error instanceof Error) {
      // Check for specific OpenRouter/OpenAI errors
      if (error.message.includes("rate limit")) {
        return {
          success: false,
          error: "Too many requests. Please try again in a moment.",
        };
      }

      if (
        error.message.includes("insufficient_quota") ||
        error.message.includes("billing")
      ) {
        return {
          success: false,
          error: "Service temporarily unavailable. Please try again later.",
        };
      }

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

// Rate limiting utility (simple in-memory implementation)
class RateLimiter {
  private requests: Map<string, number[]> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get existing requests for this key
    const existingRequests = this.requests.get(key) || [];

    // Filter out requests outside the current window
    const recentRequests = existingRequests.filter(
      (time) => time > windowStart,
    );

    // Check if under the limit
    if (recentRequests.length < this.maxRequests) {
      // Add current request
      recentRequests.push(now);
      this.requests.set(key, recentRequests);
      return true;
    }

    return false;
  }

  getRemainingTime(key: string): number {
    const requests = this.requests.get(key);
    if (!requests || requests.length === 0) return 0;

    const oldestRequest = Math.min(...requests);
    const windowEnd = oldestRequest + this.windowMs;
    const remaining = windowEnd - Date.now();

    return Math.max(0, remaining);
  }
}

// Export rate limiter instance for use in server actions
export const scriptEnhancementRateLimiter = new RateLimiter(5, 60 * 1000); // 5 requests per minute
