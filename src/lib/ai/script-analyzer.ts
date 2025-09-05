/**
 * Script analysis service for frame generation
 * Analyzes scripts to identify scene boundaries and generate frame metadata
 */

import { z } from "zod";
import {
  callOpenRouter,
  extractJSON,
  RECOMMENDED_MODELS,
  systemMessage,
  userMessage,
} from "./openrouter-client";

// Scene analysis schema
const sceneAnalysisSchema = z.object({
  scenes: z.array(
    z.object({
      scriptContent: z.string(), // The actual script text for this scene
      description: z.string(), // Brief description of what happens
      duration: z.coerce
        .number()
        .refine((val) => !Number.isNaN(val), {
          message: "Duration must be a valid number",
        })
        .optional(),
      type: z.string().optional(), // e.g., "action", "dialogue", "montage"
      intensity: z.coerce
        .number()
        .min(1)
        .max(10)
        .refine((val) => !Number.isNaN(val), {
          message: "Intensity must be a valid number",
        })
        .optional(),
    }),
  ),
  characters: z.array(z.string()).optional(),
  settings: z.array(z.string()).optional(),
  themes: z.array(z.string()).optional(),
  totalDuration: z.coerce
    .number()
    .refine((val) => !Number.isNaN(val), {
      message: "Total duration must be a valid number",
    })
    .optional(),
});

export type SceneAnalysis = z.infer<typeof sceneAnalysisSchema>;

/**
 * Analyze script to identify frame boundaries
 */
export async function analyzeScriptForFrames(
  script: string,
  _aiProvider?: "openai" | "anthropic" | "openrouter",
): Promise<SceneAnalysis> {
  if (!process.env.OPENROUTER_KEY) {
    throw new Error("OPENROUTER_KEY is not set");
  }

  // Use OpenRouter for AI-powered analysis
  const response = await callOpenRouter({
    model: RECOMMENDED_MODELS.structured,
    messages: [
      systemMessage(
        "You are a professional script analyst. Divide scripts into logical scenes for storyboard generation. You must respond with ONLY valid JSON data - no additional text, explanations, or markdown formatting. All numeric values must be actual numbers, not strings.",
      ),
      userMessage(
        `Analyze this script and divide it into 3-5 logical scenes for storyboard generation.

Script:
${script}

Divide this script into meaningful scenes. Each scene should represent a distinct part of the narrative.

For each scene:
1. Extract the EXACT text from the script that belongs to that scene
2. Include ALL the text - don't skip anything
3. The scenes together should contain the ENTIRE script with no gaps or overlaps

Return JSON with this structure:
{
  "scenes": [
    {
      "scriptContent": "The exact script text for this scene (copy directly from the script)",
      "description": "Brief description of what happens in this scene",
      "duration": 10000,
      "type": "dialogue",
      "intensity": 5
    }
  ],
  "characters": ["Character names found in script"],
  "settings": ["Locations mentioned"],
  "themes": ["Main themes"],
  "totalDuration": 30000
}

IMPORTANT:
- scriptContent must be the EXACT text from the script for that scene
- All scenes combined must equal the complete original script
- Aim for 3-5 scenes total
- Each scene should be roughly equal in length

Respond with ONLY valid JSON, no markdown or explanations.`,
      ),
    ],
    temperature: 0.1, // Very low temperature for consistent structured output
    max_tokens: 2000, // Increased to handle full script analysis
  });

  const content = response.choices[0].message.content;
  const parsed = extractJSON<SceneAnalysis>(content);

  if (!parsed) {
    throw new Error("Failed to parse AI response - invalid or missing JSON");
  }

  // Validate and return the parsed result
  return sceneAnalysisSchema.parse(parsed);
}
