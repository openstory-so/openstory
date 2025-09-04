import { beforeEach, describe, expect, it, mock } from "bun:test";
import { enhanceScript, enhanceScriptDirect } from "./enhance-script";

// Mock the AI service
const mockEnhanceScriptService = mock(() => ({
  success: true,
  data: {
    enhanced_script: "Enhanced script content",
    improvements_made: ["Added details", "Improved structure"],
    estimated_duration: 30,
    scene_count: 2,
  },
  tokenUsage: {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
  },
}));

mock.module("@/lib/ai/script-enhancer", () => ({
  enhanceScript: mockEnhanceScriptService,
  scriptEnhancementRateLimiter: {
    isAllowed: mock(() => true),
    getRemainingTime: mock(() => 0),
  },
}));

// Mock Next.js headers
const mockHeaders = mock(() => ({
  get: mock((name: string) => {
    if (name === "x-forwarded-for") return "192.168.1.1";
    if (name === "x-real-ip") return "192.168.1.1";
    return null;
  }),
}));

mock.module("next/headers", () => ({
  headers: mockHeaders,
}));

describe("Enhance Script Server Actions", () => {
  beforeEach(() => {
    mockEnhanceScriptService.mockClear();
    mockHeaders.mockClear();

    // Reset to successful response
    mockEnhanceScriptService.mockResolvedValue({
      success: true,
      data: {
        enhanced_script: "Enhanced script content",
        improvements_made: ["Added details", "Improved structure"],
        estimated_duration: 30,
        scene_count: 2,
      },
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    });
  });

  describe("enhanceScript", () => {
    it("should successfully enhance a script", async () => {
      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop");
      formData.append("targetDuration", "30");
      formData.append("tone", "dramatic");

      const result = await enhanceScript(formData);

      expect(result.success).toBe(true);
      expect(result.originalScript).toBe("A person sits in a coffee shop");
      expect(result.enhancedScript).toBe("Enhanced script content");
      expect(result.improvements).toEqual([
        "Added details",
        "Improved structure",
      ]);
      expect(result.estimatedDuration).toBe(30);
      expect(result.sceneCount).toBe(2);
      expect(result.rateLimitInfo?.isRateLimited).toBe(false);
    });

    it("should handle missing script parameter", async () => {
      const formData = new FormData();
      // Missing script parameter

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle invalid script length", async () => {
      const formData = new FormData();
      formData.append("script", "short"); // Too short (less than 10 chars)

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Script must be at least 10 characters");
    });

    it("should handle script that is too long", async () => {
      const formData = new FormData();
      formData.append("script", "a".repeat(10001)); // Too long

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Script too long");
    });

    it("should handle invalid tone parameter", async () => {
      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");
      formData.append("tone", "invalid-tone");

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle invalid target duration", async () => {
      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");
      formData.append("targetDuration", "5"); // Too short

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle AI service failure", async () => {
      mockEnhanceScriptService.mockResolvedValueOnce({
        success: false,
        error: "AI service unavailable",
      });

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("AI service unavailable");
    });

    it("should handle missing AI service data", async () => {
      mockEnhanceScriptService.mockResolvedValueOnce({
        success: true,
        data: undefined,
      });

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("No enhanced script data received");
    });

    it("should handle unexpected errors", async () => {
      mockEnhanceScriptService.mockRejectedValueOnce(
        new Error("Network error"),
      );

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("should use default values for optional parameters", async () => {
      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      await enhanceScript(formData);

      expect(mockEnhanceScriptService).toHaveBeenCalledWith({
        originalScript: "A person sits in a coffee shop writing",
        targetDuration: undefined,
        tone: undefined,
        style: undefined,
      });
    });

    it("should pass all parameters to AI service", async () => {
      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");
      formData.append("targetDuration", "45");
      formData.append("tone", "comedic");
      formData.append("style", "noir cinematography");

      await enhanceScript(formData);

      expect(mockEnhanceScriptService).toHaveBeenCalledWith({
        originalScript: "A person sits in a coffee shop writing",
        targetDuration: 45,
        tone: "comedic",
        style: "noir cinematography",
      });
    });
  });

  describe("Rate Limiting", () => {
    it("should handle rate limiting", async () => {
      // Mock rate limiter to reject request
      const { scriptEnhancementRateLimiter } = await import(
        "@/lib/ai/script-enhancer"
      );
      scriptEnhancementRateLimiter.isAllowed = mock(() => false);
      scriptEnhancementRateLimiter.getRemainingTime = mock(() => 45000); // 45 seconds

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      const result = await enhanceScript(formData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Rate limit exceeded");
      expect(result.error).toContain("45 seconds");
      expect(result.rateLimitInfo?.isRateLimited).toBe(true);
      expect(result.rateLimitInfo?.remainingTimeMs).toBe(45000);
    });

    it("should extract IP from x-forwarded-for header", async () => {
      const mockGetHeader = mock((name: string) => {
        if (name === "x-forwarded-for") return "10.0.0.1,192.168.1.1";
        return null;
      });

      mockHeaders.mockReturnValueOnce({ get: mockGetHeader });

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      await enhanceScript(formData);

      // The rate limiter should have been called with the first IP
      const { scriptEnhancementRateLimiter } = await import(
        "@/lib/ai/script-enhancer"
      );
      expect(scriptEnhancementRateLimiter.isAllowed).toHaveBeenCalledWith(
        "10.0.0.1",
      );
    });

    it("should fall back to x-real-ip header", async () => {
      const mockGetHeader = mock((name: string) => {
        if (name === "x-real-ip") return "10.0.0.2";
        return null;
      });

      mockHeaders.mockReturnValueOnce({ get: mockGetHeader });

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      await enhanceScript(formData);

      const { scriptEnhancementRateLimiter } = await import(
        "@/lib/ai/script-enhancer"
      );
      expect(scriptEnhancementRateLimiter.isAllowed).toHaveBeenCalledWith(
        "10.0.0.2",
      );
    });

    it("should use anonymous as fallback IP", async () => {
      const mockGetHeader = mock(() => null);
      mockHeaders.mockReturnValueOnce({ get: mockGetHeader });

      const formData = new FormData();
      formData.append("script", "A person sits in a coffee shop writing");

      await enhanceScript(formData);

      const { scriptEnhancementRateLimiter } = await import(
        "@/lib/ai/script-enhancer"
      );
      expect(scriptEnhancementRateLimiter.isAllowed).toHaveBeenCalledWith(
        "anonymous",
      );
    });
  });

  describe("enhanceScriptDirect", () => {
    it("should work with simple string input", async () => {
      const result = await enhanceScriptDirect(
        "A person sits in a coffee shop writing",
      );

      expect(result.success).toBe(true);
      expect(result.originalScript).toBe(
        "A person sits in a coffee shop writing",
      );
      expect(result.enhancedScript).toBe("Enhanced script content");
    });

    it("should pass options to the main function", async () => {
      await enhanceScriptDirect("A person sits in a coffee shop writing", {
        targetDuration: 45,
        tone: "comedic",
        style: "film noir",
      });

      expect(mockEnhanceScriptService).toHaveBeenCalledWith({
        originalScript: "A person sits in a coffee shop writing",
        targetDuration: 45,
        tone: "comedic",
        style: "film noir",
      });
    });

    it("should handle undefined options", async () => {
      const result = await enhanceScriptDirect(
        "A person sits in a coffee shop writing",
      );

      expect(result.success).toBe(true);
      expect(mockEnhanceScriptService).toHaveBeenCalledWith({
        originalScript: "A person sits in a coffee shop writing",
        targetDuration: undefined,
        tone: undefined,
        style: undefined,
      });
    });
  });
});
