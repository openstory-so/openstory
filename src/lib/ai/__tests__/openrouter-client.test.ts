/**
 * Tests for OpenRouter client
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  callOpenRouter,
  extractJSON,
  RECOMMENDED_MODELS,
  systemMessage,
  userMessage,
} from "../openrouter-client";

// Mock fetch globally
const mockFetch = mock<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

describe.skip("OpenRouter Client", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    // Reset environment variables
    delete process.env.OPENROUTER_KEY;
  });

  describe("callOpenRouter", () => {
    test("should return mock response when no API key is set", async () => {
      const result = await callOpenRouter({
        model: RECOMMENDED_MODELS.creative,
        messages: [userMessage("Test message")],
      });

      expect(result.id).toContain("mock-");
      expect(result.choices[0].message.role).toBe("assistant");
      expect(result.choices[0].message.content).toContain("mock response");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("should call OpenRouter API when key is set", async () => {
      process.env.OPENROUTER_KEY = "test-api-key";

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "test-id",
          choices: [
            {
              message: {
                role: "assistant",
                content: "Test response",
              },
              finish_reason: "stop",
            },
          ],
          model: RECOMMENDED_MODELS.creative,
        }),
      } as Response);

      const result = await callOpenRouter({
        model: RECOMMENDED_MODELS.creative,
        messages: [userMessage("Test message")],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
          }),
        }),
      );

      expect(result.id).toBe("test-id");
      expect(result.choices[0].message.content).toBe("Test response");
    });

    test("should fall back to mock on API error", async () => {
      process.env.OPENROUTER_KEY = "test-api-key";

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as Response);

      const result = await callOpenRouter({
        model: RECOMMENDED_MODELS.fast,
        messages: [userMessage("Test message")],
      });

      expect(result.id).toContain("mock-");
      expect(result.choices[0].message.content).toContain("mock response");
    });

    test("should handle frame description requests in mock mode", async () => {
      const result = await callOpenRouter({
        model: RECOMMENDED_MODELS.creative,
        messages: [
          systemMessage("You are a storyboard artist"),
          userMessage("Generate a frame description for a scene"),
        ],
      });

      expect(result.choices[0].message.content).toContain("cinematic");
      expect(result.choices[0].message.content).toContain("frame");
    });
  });

  describe("Message helpers", () => {
    test("should create proper message objects", () => {
      const system = systemMessage("System prompt");
      const user = userMessage("User prompt");

      expect(system).toEqual({ role: "system", content: "System prompt" });
      expect(user).toEqual({ role: "user", content: "User prompt" });
    });
  });

  describe("extractJSON", () => {
    test("should extract JSON from plain string", () => {
      const json = '{"test": "value"}';
      const result = extractJSON<{ test: string }>(json);
      expect(result).toEqual({ test: "value" });
    });

    test("should extract JSON from markdown code block", () => {
      const markdown = '```json\n{"test": "value"}\n```';
      const result = extractJSON<{ test: string }>(markdown);
      expect(result).toEqual({ test: "value" });
    });

    test("should extract JSON from text with surrounding content", () => {
      const text = 'Here is the result: {"test": "value"} and some more text';
      const result = extractJSON<{ test: string }>(text);
      expect(result).toEqual({ test: "value" });
    });

    test("should return null for invalid JSON", () => {
      const invalid = "This is not JSON";
      const result = extractJSON(invalid);
      expect(result).toBeNull();
    });
  });

  describe("Model recommendations", () => {
    test("should have correct model recommendations", () => {
      expect(RECOMMENDED_MODELS.creative).toBe("anthropic/claude-3-haiku");
      expect(RECOMMENDED_MODELS.structured).toBe("openai/gpt-4o-mini");
      expect(RECOMMENDED_MODELS.fast).toBe("anthropic/claude-3-haiku");
      expect(RECOMMENDED_MODELS.premium).toBe("anthropic/claude-3-opus");
    });
  });
});
