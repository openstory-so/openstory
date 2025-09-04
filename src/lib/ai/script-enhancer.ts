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

// Output validation schema for the new format
const StyleStackRecommendationSchema = z.object({
  recommended_style_stack: z.string(),
  reasoning: z.string(),
});

const EnhancedScriptSchema = z.object({
  enhanced_script: z.string(),
  style_stack_recommendation: StyleStackRecommendationSchema,
});

export interface EnhanceScriptOptions {
  originalScript: string;
  targetDuration?: number; // Default 30 seconds
  tone?: "dramatic" | "comedic" | "documentary" | "action";
  style?: string; // Optional style context
}

export interface StyleStackRecommendation {
  recommended_style_stack: string;
  reasoning: string;
}

export interface EnhancedScript {
  enhanced_script: string;
  style_stack_recommendation: StyleStackRecommendation;
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
      apiKey: process.env.OPENROUTER_KEY || "test-key",
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return openrouter;
}

// System prompt for script enhancement - exact prompt from GitHub issue
const VELRO_SCRIPT_ENHANCER_PROMPT = `You are Velro's AI Script Enhancer.

Your role is to transform very short, vague, or incomplete user-provided scripts into highly detailed, cinematic sequences suitable for Velro's storyboard generation pipeline.

You must act as a **story analyst, cinematographer, and visual director combined**.

Your objectives:
1. **Enhance minimal inputs** into vivid, emotionally engaging scenes.
2. **Infer cinematic pacing** and structure actions into logical beats.
3. Integrate **camera language** (shot types, framing, movement) even when not explicitly requested.
4. Automatically suggest an appropriate **Velro style stack** based on tone and context.
5. Output a **detailed cinematic script** plus a structured JSON summary containing the recommended style stack.

---

## **Core Rules**

### **A. Story Expansion**
- If the user provides fewer than ~25 words, assume the script is **incomplete** and enhance it.
- Preserve the **intent and meaning** but add:
    - Atmospheric details (lighting, sound, textures, props).
    - Character expressions, subtle behaviours, and emotional undertones.
    - Dialogue snippets where natural, but avoid overloading.
    - Environmental cues that create immersion.

### **B. Cinematic Language**
Always embed implicit camera direction:
- **Shot Types:** Wide establishing, medium tracking, close-up, insert, over-the-shoulder, two-shot, extreme close-up.
- **Camera Movement:** Static, handheld, dolly, tracking, crane, whip-pan, Steadicam.
- **Depth & Composition:** Mention shallow DOF, anamorphic flares, wides, or compressed depth when relevant.
- **Lighting Cues:** Practical sources, rim separation, key/fill ratios, colour temperature.

### **C. Velro Style Stack Mapping**
At the end of the enhanced script, infer which Velro cinematic style stack fits best:
- **A24 Dreamy Warm** → soft, nostalgic, intimate, muted tones.
- **Villeneuve Earthy Futurism** → grand scale, surreal tension, minimalistic palettes.
- **Fincher Neo-Noir** → cold, precise, clinical, high-contrast.
- **Pixar Brighter Worlds** → colourful, vibrant, animated tone.
- **Tarantino Reds & Chaos** → explosive, chaotic, bold saturation.

Default to **A24 Dreamy Warm** if uncertain.

### **D. Scene Pacing**
- Split the sequence into **visual beats** when necessary.
- Each beat should represent a potential storyboard frame or cluster.
- Assume these will later feed into Velro's storyboard chunking engine.

### **E. Environmental Enrichment**
Always enhance realism with:
- Ambient sounds
- Background details
- Light behaviour
- Emotional undertones
- Colours and textures

---

## **Output Format**

**CRITICAL: OUTPUT ONLY THE ENHANCED SCRIPT AND JSON. NO PREAMBLE, NO INTRODUCTION, NO EXPLANATIONS.**

### **1. Enhanced Cinematic Script**
Start immediately with the enhanced screenplay. Begin directly with "FADE IN:" or the first scene element. Do not include any introductory text, explanations, or commentary.

### **2. Style Stack Recommendation**
After the script, provide a **JSON block**:
\`\`\`json
{
  "recommended_style_stack": "a24-dreamy-1",
  "reasoning": "Intimate lighting, muted tones, emotional tension, and soft tungsten glows suggest A24's dreamy warm style."
}
\`\`\`

Key Requirements
• Output ONLY the enhanced script followed by the JSON block
• DO NOT include any preamble, introduction, or explanation before the script
• Begin immediately with the screenplay content
• Always produce richly visual outputs
• Keep the script natural and cinematic
• Always provide a recommended Velro style stack in JSON
• Ensure outputs are storyboard-friendly and ready for downstream generation`;

const createSystemPrompt = (): string => {
  return VELRO_SCRIPT_ENHANCER_PROMPT;
};

// Create user prompt
const createUserPrompt = (originalScript: string): string => {
  return `Please enhance this script for a short film:

"${originalScript}"

Transform it into a professional, visually detailed script that tells a complete story within the target duration.`;
};

// Parse the enhanced script response which contains both script text and JSON metadata
function parseEnhancedScriptResponse(response: string): {
  enhancedScript: string;
  styleRecommendation: StyleStackRecommendation;
} {
  // Look for JSON block in the response
  const jsonRegex = /```json\s*\n([\s\S]*?)\n\s*```/;
  const jsonMatch = response.match(jsonRegex);

  if (!jsonMatch) {
    throw new Error("No JSON metadata found in AI response");
  }

  let styleRecommendation: StyleStackRecommendation;
  try {
    const jsonData = JSON.parse(jsonMatch[1]);
    styleRecommendation = StyleStackRecommendationSchema.parse(jsonData);
  } catch (parseError) {
    throw new Error(`Failed to parse style recommendation JSON: ${parseError}`);
  }

  // Extract the enhanced script text (everything before the JSON block)
  const scriptEndIndex = response.indexOf(jsonMatch[0]);
  let enhancedScript = response.substring(0, scriptEndIndex).trim();

  if (!enhancedScript) {
    throw new Error("No enhanced script text found in AI response");
  }

  // Remove any preamble text that might precede the actual script
  // Look for common screenplay starting patterns (allowing for line breaks and whitespace)
  const scriptStartPatterns = [
    /FADE IN:/i,
    /INT\./i,
    /EXT\./i,
    /OVER BLACK:/i,
    /TITLE CARD:/i,
    /CLOSE-UP:/i,
    /WIDE SHOT:/i,
    /ESTABLISHING SHOT:/i,
  ];

  // Find the first occurrence of any screenplay pattern
  let scriptStartIndex = -1;
  for (const pattern of scriptStartPatterns) {
    const match = enhancedScript.search(pattern);
    if (match !== -1) {
      if (scriptStartIndex === -1 || match < scriptStartIndex) {
        scriptStartIndex = match;
      }
    }
  }

  // If we found a screenplay pattern, strip everything before it
  if (scriptStartIndex > 0) {
    enhancedScript = enhancedScript.substring(scriptStartIndex).trim();
  }

  // Final check to ensure we have content
  if (!enhancedScript) {
    throw new Error(
      "No enhanced script text found in AI response after preamble removal",
    );
  }

  return {
    enhancedScript,
    styleRecommendation,
  };
}

export async function enhanceScript(
  options: EnhanceScriptOptions,
): Promise<ScriptEnhancementResult> {
  try {
    // Validate input
    const validatedOptions = EnhanceScriptOptionsSchema.parse(options);

    // Check if OpenRouter API key is configured
    if (!process.env.OPENROUTER_KEY) {
      throw new Error("OpenRouter API key not configured");
    }

    // Create prompts
    const systemPrompt = createSystemPrompt();
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
      max_tokens: 1500,
      temperature: 0.7,
    });

    const response = completion.choices[0]?.message?.content;

    if (!response) {
      throw new Error("No response received from AI service");
    }

    // Parse the response which contains enhanced script text and JSON metadata
    const { enhancedScript, styleRecommendation } =
      parseEnhancedScriptResponse(response);

    // Create the structured response
    const validatedResponse: EnhancedScript = {
      enhanced_script: enhancedScript,
      style_stack_recommendation: styleRecommendation,
    };

    // Validate the response structure
    EnhancedScriptSchema.parse(validatedResponse);

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
