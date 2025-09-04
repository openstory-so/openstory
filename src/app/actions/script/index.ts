import { enhanceScriptDirect } from "@/app/actions/enhance-script";

// Re-export existing mock validation (we'll keep this as-is for now)
export { validateScript } from "./index.mock";

// Script enhancement using real AI service
export async function enhanceScript(originalScript: string): Promise<{
  success: boolean;
  originalScript: string;
  enhancedScript: string;
  improvements: string[];
  error?: string;
}> {
  try {
    const result = await enhanceScriptDirect(originalScript, {
      targetDuration: 30,
      tone: "dramatic",
    });

    if (!result.success) {
      return {
        success: false,
        originalScript,
        enhancedScript: originalScript,
        improvements: [],
        error: result.error,
      };
    }

    return {
      success: true,
      originalScript,
      enhancedScript: result.enhancedScript || originalScript,
      improvements: result.improvements || [],
    };
  } catch (error) {
    console.error("Script enhancement failed:", error);
    return {
      success: false,
      originalScript,
      enhancedScript: originalScript,
      improvements: [],
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
