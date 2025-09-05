/**
 * OpenRouter API client for AI services
 * Provides a unified interface to multiple AI models
 */

import { z } from "zod";

// OpenRouter API configuration
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Response schema for OpenRouter API
const openRouterResponseSchema = z.object({
  id: z.string(),
  choices: z.array(
    z.object({
      message: z.object({
        role: z.string(),
        content: z.string(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  model: z.string(),
});

export type OpenRouterResponse = z.infer<typeof openRouterResponseSchema>;

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterRequestParams {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
}

/**
 * Model recommendations for different tasks
 */
export const RECOMMENDED_MODELS = {
  // For creative writing and scene descriptions
  creative: "anthropic/claude-3-haiku",

  // For structured data extraction
  structured: "openai/gpt-4o-mini",

  // For fast responses with good quality
  fast: "anthropic/claude-3-haiku",

  // For highest quality (more expensive)
  premium: "anthropic/claude-3-opus",
} as const;

/**
 * Make a request to OpenRouter API
 */
export async function callOpenRouter(
  params: OpenRouterRequestParams,
): Promise<OpenRouterResponse> {
  const apiKey = process.env.OPENROUTER_KEY;

  if (!apiKey) {
    console.warn(
      "[OpenRouter] No API key found, using mock response. Set OPENROUTER_KEY environment variable.",
    );
    return getMockResponse(params);
  }

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://velro.ai",
        "X-Title": "Velro AI",
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.max_tokens ?? 1000,
        top_p: params.top_p ?? 1,
        frequency_penalty: params.frequency_penalty ?? 0,
        presence_penalty: params.presence_penalty ?? 0,
        stream: params.stream ?? false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[OpenRouter] API error:", error);
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const validated = openRouterResponseSchema.parse(data);

    return validated;
  } catch (error) {
    console.error("[OpenRouter] Request failed:", error);
    // Fall back to mock response in case of error
    return getMockResponse(params);
  }
}

/**
 * Generate a mock response for testing/development
 */
function getMockResponse(params: OpenRouterRequestParams): OpenRouterResponse {
  const lastMessage = params.messages[params.messages.length - 1];
  const isFrameDescription = lastMessage.content.includes("frame description");

  let content = "Mock AI response: ";

  if (isFrameDescription) {
    content = `A cinematic wide shot reveals the scene with dramatic lighting and careful composition. The frame captures the essential narrative elements while maintaining visual coherence with the established style. Characters are positioned thoughtfully within the frame, their expressions and body language conveying the emotional weight of the moment. The environment is richly detailed, with atmospheric elements that enhance the storytelling.`;
  } else {
    content = `This is a mock response for: ${lastMessage.content.slice(0, 100)}...`;
  }

  return {
    id: `mock-${Date.now()}`,
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
    model: params.model,
  };
}

/**
 * Helper function to create a system message
 */
export function systemMessage(content: string): OpenRouterMessage {
  return { role: "system", content };
}

/**
 * Helper function to create a user message
 */
export function userMessage(content: string): OpenRouterMessage {
  return { role: "user", content };
}

/**
 * Helper function to create an assistant message
 */
export function assistantMessage(content: string): OpenRouterMessage {
  return { role: "assistant", content };
}

/**
 * Extract JSON from a potentially wrapped response
 */
export function extractJSON<T>(content: string): T | null {
  try {
    // Try direct parse first
    return JSON.parse(content) as T;
  } catch {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as T;
      } catch {
        // Continue to next attempt
      }
    }

    // Try to find JSON object in the text
    const objectMatch = content.match(/{[\s\S]*}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as T;
      } catch {
        return null;
      }
    }

    return null;
  }
}
