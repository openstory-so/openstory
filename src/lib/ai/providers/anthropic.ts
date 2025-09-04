/**
 * Anthropic AI Provider Service
 * Handles integration with Claude API for script enhancement
 */

import { z } from "zod";

// Environment validation
const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "Anthropic API key is required"),
});

// Response schemas
export const claudeResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  ),
  model: z.string(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export type ClaudeResponse = z.infer<typeof claudeResponseSchema>;

// Configuration
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-3-5-sonnet-20241022"; // Latest Claude Sonnet model
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.7;

export interface AnthropicConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AnthropicRequest {
  messages: AnthropicMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export class AnthropicProvider {
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private timeout: number;

  constructor(config?: AnthropicConfig) {
    // Validate environment
    const env = envSchema.parse({
      ANTHROPIC_API_KEY: config?.apiKey || process.env.ANTHROPIC_API_KEY,
    });

    this.apiKey = env.ANTHROPIC_API_KEY;
    this.model = config?.model || CLAUDE_MODEL;
    this.maxTokens = config?.maxTokens || MAX_TOKENS;
    this.temperature = config?.temperature || TEMPERATURE;
    this.timeout = config?.timeout || 30000; // 30 seconds default
  }

  /**
   * Send a completion request to Claude
   */
  async complete(request: AnthropicRequest): Promise<ClaudeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens || this.maxTokens,
          temperature: request.temperature || this.temperature,
          system: request.system,
          messages: request.messages,
          stream: request.stream || false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      return claudeResponseSchema.parse(data);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error(`Request timed out after ${this.timeout}ms`);
        }
        throw error;
      }

      throw new Error("Unknown error occurred while calling Anthropic API");
    }
  }

  /**
   * Simple text completion helper
   */
  async completeText(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await this.complete({
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content[0]?.text || "";
  }

  /**
   * Calculate estimated cost for a request
   */
  estimateCost(inputTokens: number, outputTokens: number): number {
    // Claude 3.5 Sonnet pricing (as of 2024)
    // Input: $3 per million tokens
    // Output: $15 per million tokens
    const inputCost = (inputTokens / 1_000_000) * 3;
    const outputCost = (outputTokens / 1_000_000) * 15;
    return inputCost + outputCost;
  }

  /**
   * Estimate token count (rough approximation)
   * More accurate counting would require tiktoken or similar
   */
  estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}

// Singleton instance for convenience
let instance: AnthropicProvider | null = null;

export function getAnthropicProvider(
  config?: AnthropicConfig,
): AnthropicProvider {
  if (!instance) {
    instance = new AnthropicProvider(config);
  }
  return instance;
}

// Rate limiting helper
export class RateLimiter {
  private requests: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 50, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async checkLimit(): Promise<boolean> {
    const now = Date.now();
    this.requests = this.requests.filter((time) => now - time < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      return false;
    }

    this.requests.push(now);
    return true;
  }

  getResetTime(): number {
    if (this.requests.length === 0) return 0;
    const oldestRequest = Math.min(...this.requests);
    return oldestRequest + this.windowMs;
  }
}
