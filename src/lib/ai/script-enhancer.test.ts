import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock OpenAI completely before importing the module under test
const mockChatCompletionsCreate = mock(() => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          enhanced_script:
            "FADE IN: A bustling coffee shop filled with morning rush. SARAH, 28, determined writer, sits by the window typing furiously. Her laptop screen reflects her focused expression. The camera pulls back to reveal the city awakening outside.",
          improvements_made: [
            "Added specific character details",
            "Enhanced visual descriptions",
            "Improved scene setting",
            "Added camera direction",
          ],
          estimated_duration: 30,
          scene_count: 1,
        }),
      },
    },
  ],
  usage: {
    prompt_tokens: 150,
    completion_tokens: 75,
    total_tokens: 225,
  },
}));

mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockChatCompletionsCreate,
        },
      };
    },
  };
});

// Import the module after mocking
import { enhanceScript, scriptEnhancementRateLimiter } from "./script-enhancer";

// Mock environment variable
const _originalEnv = process.env.OPENROUTER_KEY;

describe("Script Enhancer", () => {
  beforeEach(() => {
    mockChatCompletionsCreate.mockClear();
    process.env.OPENROUTER_KEY = "test-api-key";
  });

  // Clean up in beforeEach instead since Bun test doesn't have afterEach

  describe("enhanceScript", () => {
    it("should successfully enhance a script", async () => {
      const options = {
        originalScript: "A person sits in a coffee shop",
        targetDuration: 30,
        tone: "dramatic" as const,
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.enhanced_script).toContain("coffee shop");
      expect(result.data?.improvements_made).toHaveLength(4);
      expect(result.data?.estimated_duration).toBe(30);
      expect(result.data?.scene_count).toBe(1);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.totalTokens).toBe(225);

      // Verify the API was called correctly
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: "anthropic/claude-3.5-sonnet",
        messages: [
          {
            role: "system",
            content: expect.stringContaining("professional screenwriter"),
          },
          {
            role: "user",
            content: expect.stringContaining("A person sits in a coffee shop"),
          },
        ],
        max_tokens: 1000,
        temperature: 0.7,
        response_format: { type: "json_object" },
      });
    });

    it("should handle missing API key", async () => {
      delete process.env.OPENROUTER_KEY;

      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("OpenRouter API key not configured");
    });

    it("should validate input parameters", async () => {
      const options = {
        originalScript: "", // Empty script
        targetDuration: 5, // Too short
        tone: "invalid" as any,
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle AI API errors", async () => {
      mockChatCompletionsCreate.mockRejectedValueOnce(new Error("API Error"));

      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(false);
      expect(result.error).toBe("API Error");
    });

    it("should handle rate limiting errors", async () => {
      mockChatCompletionsCreate.mockRejectedValueOnce(
        new Error("rate limit exceeded"),
      );

      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Too many requests");
    });

    it("should handle invalid JSON response", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "invalid json response",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to parse AI response as JSON");
    });

    it("should handle malformed AI response structure", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                wrong_field: "value",
                missing_required: true,
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should use default values for optional parameters", async () => {
      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(true);

      // Check that the system prompt includes default values
      const systemPrompt =
        mockChatCompletionsCreate.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain("30 seconds"); // default duration
      expect(systemPrompt).toContain("dramatic"); // default tone
    });

    it("should incorporate style context when provided", async () => {
      const options = {
        originalScript: "A person sits in a coffee shop",
        style: "noir cinematography",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(true);

      const systemPrompt =
        mockChatCompletionsCreate.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain("noir cinematography");
    });
  });

  describe("RateLimiter", () => {
    it("should allow requests within the limit", () => {
      const limiter = new (scriptEnhancementRateLimiter.constructor as any)(
        3,
        60000,
      ); // 3 requests per minute

      expect(limiter.isAllowed("user1")).toBe(true);
      expect(limiter.isAllowed("user1")).toBe(true);
      expect(limiter.isAllowed("user1")).toBe(true);
    });

    it("should block requests exceeding the limit", () => {
      const limiter = new (scriptEnhancementRateLimiter.constructor as any)(
        2,
        60000,
      ); // 2 requests per minute

      expect(limiter.isAllowed("user2")).toBe(true);
      expect(limiter.isAllowed("user2")).toBe(true);
      expect(limiter.isAllowed("user2")).toBe(false);
    });

    it("should track different users separately", () => {
      const limiter = new (scriptEnhancementRateLimiter.constructor as any)(
        1,
        60000,
      ); // 1 request per minute

      expect(limiter.isAllowed("user3")).toBe(true);
      expect(limiter.isAllowed("user4")).toBe(true);
      expect(limiter.isAllowed("user3")).toBe(false);
      expect(limiter.isAllowed("user4")).toBe(false);
    });

    it("should calculate remaining time correctly", () => {
      const limiter = new (scriptEnhancementRateLimiter.constructor as any)(
        1,
        60000,
      ); // 1 request per minute

      limiter.isAllowed("user5"); // Use up the limit
      const remainingTime = limiter.getRemainingTime("user5");

      expect(remainingTime).toBeGreaterThan(59000); // Should be close to 60 seconds
      expect(remainingTime).toBeLessThanOrEqual(60000);
    });

    it("should return 0 remaining time for users with no requests", () => {
      const limiter = new (scriptEnhancementRateLimiter.constructor as any)(
        1,
        60000,
      );

      const remainingTime = limiter.getRemainingTime("unknown-user");
      expect(remainingTime).toBe(0);
    });
  });
});
