/**
 * OpenRouter Service Layer
 * Enterprise-ready LLM service for script analysis and text generation
 */

import type { OpenRouterModel } from "./models";
import { MODEL_PRICING, OPENROUTER_MODELS } from "./models";

// OpenRouter API configuration
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Service response interface
export interface OpenRouterServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs?: number;
  cost?: number;
  tokensUsed?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

// Message interface
export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: string }>;
}

// Request parameters
export interface OpenRouterRequestParams {
  model: OpenRouterModel;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
}

// Response interface
export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenRouter Service Class
 * Handles all OpenRouter API interactions
 */
export class OpenRouterService {
  private apiKey: string;

  constructor() {
    const apiKey = process.env.OPENROUTER_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_KEY environment variable is required");
    }
    this.apiKey = apiKey;
  }

  /**
   * Make a request to OpenRouter API
   */
  async chat(
    params: OpenRouterRequestParams,
  ): Promise<OpenRouterServiceResponse<OpenRouterResponse>> {
    const startTime = Date.now();

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = (await response.json()) as OpenRouterResponse;
      const latencyMs = Date.now() - startTime;

      // Calculate cost based on token usage
      const cost = this.calculateCost(params.model, data.usage);

      return {
        success: true,
        data,
        latencyMs,
        cost,
        tokensUsed: {
          prompt: data.usage.prompt_tokens,
          completion: data.usage.completion_tokens,
          total: data.usage.total_tokens,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      console.error("[OpenRouter] Request failed:", error);

      return {
        success: false,
        error: errorMessage,
        latencyMs,
      };
    }
  }

  /**
   * Analyze script and extract scenes
   */
  async analyzeScript(params: {
    script: string;
    framesPerScene?: number;
  }): Promise<
    OpenRouterServiceResponse<{
      scenes: Array<{
        sceneNumber: number;
        description: string;
        frames: Array<{
          frameNumber: number;
          description: string;
          visualElements: string[];
        }>;
      }>;
    }>
  > {
    const systemPrompt = `You are a professional script analyst for a cinematic content creation platform. 
Your task is to analyze scripts and break them down into scenes and frames for visual generation.

For each scene:
1. Identify the key visual moments
2. Break it into ${params.framesPerScene || 3} frames
3. Provide detailed visual descriptions for each frame
4. List key visual elements (characters, objects, lighting, mood)

Return your analysis as a JSON object with this structure:
{
  "scenes": [
    {
      "sceneNumber": 1,
      "description": "Scene description",
      "frames": [
        {
          "frameNumber": 1,
          "description": "Detailed visual description",
          "visualElements": ["element1", "element2"]
        }
      ]
    }
  ]
}`;

    const result = await this.chat({
      model: OPENROUTER_MODELS.claude_haiku, // Fast and cost-effective
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.script },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || "Failed to analyze script",
        latencyMs: result.latencyMs,
      };
    }

    try {
      // Parse the JSON response
      const content = result.data.choices[0]?.message.content;
      if (!content) {
        throw new Error("No content in response");
      }
      const parsed = JSON.parse(content);

      return {
        success: true,
        data: parsed,
        latencyMs: result.latencyMs,
        cost: result.cost,
        tokensUsed: result.tokensUsed,
      };
    } catch (_error) {
      return {
        success: false,
        error: "Failed to parse script analysis response",
        latencyMs: result.latencyMs,
      };
    }
  }

  /**
   * Generate frame description from scene context
   */
  async generateFrameDescription(params: {
    sceneDescription: string;
    frameNumber: number;
    totalFrames: number;
  }): Promise<OpenRouterServiceResponse<{ description: string }>> {
    const systemPrompt = `You are a professional cinematographer creating detailed visual descriptions for AI image generation.
Create a vivid, detailed description for frame ${params.frameNumber} of ${params.totalFrames} in this scene.
Focus on: composition, lighting, mood, camera angle, and key visual elements.
Keep it concise but descriptive (2-3 sentences).`;

    const result = await this.chat({
      model: OPENROUTER_MODELS.claude_haiku,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.sceneDescription },
      ],
      temperature: 0.8,
      max_tokens: 200,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || "Failed to generate frame description",
        latencyMs: result.latencyMs,
      };
    }

    const description = result.data.choices[0]?.message.content || "";

    return {
      success: true,
      data: { description },
      latencyMs: result.latencyMs,
      cost: result.cost,
      tokensUsed: result.tokensUsed,
    };
  }

  /**
   * Calculate cost based on token usage
   */
  private calculateCost(
    model: OpenRouterModel,
    usage: { prompt_tokens: number; completion_tokens: number },
  ): number {
    const pricePerMillion =
      MODEL_PRICING[model as keyof typeof MODEL_PRICING] || 0;

    // Calculate cost in USD
    const promptCost = (usage.prompt_tokens / 1_000_000) * pricePerMillion;
    const completionCost =
      (usage.completion_tokens / 1_000_000) * pricePerMillion;

    return promptCost + completionCost;
  }

  /**
   * Check OpenRouter service health
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      const result = await this.chat({
        model: OPENROUTER_MODELS.claude_haiku,
        messages: [{ role: "user", content: "health check" }],
        max_tokens: 10,
      });

      return {
        healthy: result.success,
        latencyMs: Date.now() - startTime,
        error: result.error,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

// Singleton instance
let openRouterServiceInstance: OpenRouterService | null = null;

/**
 * Get OpenRouter service instance
 */
export function getOpenRouterService(): OpenRouterService {
  if (!openRouterServiceInstance) {
    openRouterServiceInstance = new OpenRouterService();
  }
  return openRouterServiceInstance;
}
