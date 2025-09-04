import { beforeEach, describe, expect, it, type Mock, mock } from "bun:test";

// Mock OpenAI completely before importing the module under test
const mockChatCompletionsCreate = mock() as Mock<() => Promise<any>>;

// Set default implementation
mockChatCompletionsCreate.mockResolvedValue({
  choices: [
    {
      message: {
        content: `FADE IN: A bustling coffee shop filled with morning rush. The warm amber light filters through large windows, casting gentle shadows across weathered wooden tables. SARAH, 28, determined writer with tired but focused eyes, sits at a corner table by the window. Her fingers dance across the laptop keyboard with practiced urgency.

CLOSE-UP: Her laptop screen reflects her concentrated expression, text cascading down the document. The camera slowly PULLS BACK through the window glass, revealing the city awakening outside - early commuters hurrying past, steam rising from manholes, the first golden hour of dawn painting the streetscape.

The coffee shop hums with quiet energy: the espresso machine's gentle hiss, distant conversations mixing with soft jazz, the rustle of newspapers. Sarah pauses, taking a sip of her coffee, steam curling upward as she gazes out at the city, finding inspiration in its rhythm.

\`\`\`json
{
  "recommended_style_stack": "a24-dreamy-1",
  "reasoning": "Intimate coffee shop setting with warm amber lighting, soft focus elements, and contemplative mood suggests A24's dreamy warm aesthetic with muted tones and emotional undertones."
}
\`\`\``,
      },
    },
  ],
  usage: {
    prompt_tokens: 150,
    completion_tokens: 200,
    total_tokens: 350,
  },
});

// Reset mock before each describe block
mockChatCompletionsCreate.mockClear();

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
import {
  enhanceScript,
  resetOpenRouterClient,
  scriptEnhancementRateLimiter,
} from "./script-enhancer";

// Mock environment variable
const _originalEnv = process.env.OPENROUTER_KEY;

describe("Script Enhancer", () => {
  beforeEach(() => {
    mockChatCompletionsCreate.mockClear();
    process.env.OPENROUTER_KEY = "test-api-key";

    // Reset the OpenAI client instance by clearing it
    resetOpenRouterClient();

    // Reset to default mock response
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: `FADE IN: A bustling coffee shop filled with morning rush. The warm amber light filters through large windows, casting gentle shadows across weathered wooden tables. SARAH, 28, determined writer with tired but focused eyes, sits at a corner table by the window. Her fingers dance across the laptop keyboard with practiced urgency.

CLOSE-UP: Her laptop screen reflects her concentrated expression, text cascading down the document. The camera slowly PULLS BACK through the window glass, revealing the city awakening outside - early commuters hurrying past, steam rising from manholes, the first golden hour of dawn painting the streetscape.

The coffee shop hums with quiet energy: the espresso machine's gentle hiss, distant conversations mixing with soft jazz, the rustle of newspapers. Sarah pauses, taking a sip of her coffee, steam curling upward as she gazes out at the city, finding inspiration in its rhythm.

\`\`\`json
{
  "recommended_style_stack": "a24-dreamy-1",
  "reasoning": "Intimate coffee shop setting with warm amber lighting, soft focus elements, and contemplative mood suggests A24's dreamy warm aesthetic with muted tones and emotional undertones."
}
\`\`\``,
          },
        },
      ],
      usage: {
        prompt_tokens: 150,
        completion_tokens: 200,
        total_tokens: 350,
      },
    });
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
      expect(result.data?.enhanced_script).toContain("SARAH");
      expect(result.data?.style_stack_recommendation).toBeDefined();
      expect(
        result.data?.style_stack_recommendation.recommended_style_stack,
      ).toBe("a24-dreamy-1");
      expect(result.data?.style_stack_recommendation.reasoning).toContain(
        "A24",
      );
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.totalTokens).toBe(350);

      // Verify the API was called correctly
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: "anthropic/claude-3.5-sonnet",
        messages: [
          {
            role: "system",
            content: expect.stringContaining("Velro's AI Script Enhancer"),
          },
          {
            role: "user",
            content: expect.stringContaining("A person sits in a coffee shop"),
          },
        ],
        max_tokens: 1500,
        temperature: 0.7,
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

    it("should handle response without enhanced script text", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: `\`\`\`json
{
  "recommended_style_stack": "a24-dreamy-1",
  "reasoning": "Test reasoning"
}
\`\`\``,
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
      expect(result.error).toContain(
        "No enhanced script text found in AI response",
      );
    });

    it("should handle malformed AI response structure", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "Some script text without JSON block",
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
      expect(result.error).toContain("No JSON metadata found in AI response");
    });

    it("should use default values for optional parameters", async () => {
      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(true);

      // Check that the API was called correctly
      expect(mockChatCompletionsCreate).toHaveBeenCalled();
    });

    it("should use the Velro system prompt correctly", async () => {
      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      await enhanceScript(options);

      // Verify the mock was called with correct structure
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith({
        model: "anthropic/claude-3.5-sonnet",
        messages: [
          {
            role: "system",
            content: expect.stringContaining(
              "You are Velro's AI Script Enhancer",
            ),
          },
          {
            role: "user",
            content: expect.stringContaining("A person sits in a coffee shop"),
          },
        ],
        max_tokens: 1500,
        temperature: 0.7,
      });
    });

    it("should handle missing JSON block in response", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "Enhanced script text but no JSON metadata",
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
      expect(result.error).toContain("No JSON metadata found");
    });

    it("should handle invalid JSON in metadata block", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: `Some enhanced script text

\`\`\`json
{ "recommended_style_stack": "a24-dreamy-1", "missing_reasoning": true }
\`\`\``,
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
      expect(result.error).toContain(
        "Failed to parse style recommendation JSON",
      );
    });

    it("should strip preamble text and start with screenplay content", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: `I'll enhance this beautiful morning scene for you by creating a detailed cinematic sequence.

FADE IN: A bustling coffee shop filled with morning rush. The warm amber light filters through large windows, casting gentle shadows across weathered wooden tables. SARAH, 28, determined writer with tired but focused eyes, sits at a corner table by the window.

CLOSE-UP: Her laptop screen reflects her concentrated expression, text cascading down the document. The camera slowly PULLS BACK through the window glass, revealing the city awakening outside.

\`\`\`json
{
  "recommended_style_stack": "a24-dreamy-1",
  "reasoning": "Intimate coffee shop setting with warm lighting suggests A24's dreamy warm aesthetic."
}
\`\`\``,
            },
          },
        ],
        usage: {
          prompt_tokens: 150,
          completion_tokens: 200,
          total_tokens: 350,
        },
      });

      const options = {
        originalScript: "A person sits in a coffee shop",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(true);
      expect(result.data?.enhanced_script).toBeDefined();

      // Should NOT contain the preamble text
      expect(result.data?.enhanced_script).not.toContain(
        "I'll enhance this beautiful morning scene",
      );
      expect(result.data?.enhanced_script).not.toContain(
        "by creating a detailed cinematic sequence",
      );

      // Should start directly with the screenplay
      expect(result.data?.enhanced_script).toMatch(/^FADE IN:/);
      expect(result.data?.enhanced_script).toContain("coffee shop");
      expect(result.data?.enhanced_script).toContain("SARAH");
    });

    it("should handle preamble with different screenplay starting patterns", async () => {
      mockChatCompletionsCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: `Here's the enhanced version of your script with cinematic details.

INT. COFFEE SHOP - MORNING

The space buzzes with morning energy as patrons rush in and out. Steam rises from cups while the espresso machine hisses rhythmically.

\`\`\`json
{
  "recommended_style_stack": "fincher-neo-noir-1",
  "reasoning": "The interior setting with controlled lighting suggests Fincher's precise aesthetic."
}
\`\`\``,
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 150,
          total_tokens: 250,
        },
      });

      const options = {
        originalScript: "Interior coffee shop scene",
      };

      const result = await enhanceScript(options);

      expect(result.success).toBe(true);
      expect(result.data?.enhanced_script).toBeDefined();

      // Should NOT contain the preamble text
      expect(result.data?.enhanced_script).not.toContain(
        "Here's the enhanced version",
      );
      expect(result.data?.enhanced_script).not.toContain(
        "with cinematic details",
      );

      // Should start directly with the screenplay
      expect(result.data?.enhanced_script).toMatch(
        /^INT\. COFFEE SHOP - MORNING/,
      );
      expect(result.data?.enhanced_script).toContain(
        "buzzes with morning energy",
      );
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
