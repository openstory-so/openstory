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

Your task: Extract meaningful chunks of the script text for each scene.

For video scripts that have marked sections (like [0-3s] Hook, [4-10s] Setup, etc.), use those as your scene boundaries.
For scripts without clear markings, divide into logical narrative sections.

For each scene:
1. Copy the COMPLETE text content from that section of the script
2. Include dialogue, stage directions, everything in that section
3. Make sure each scene has substantial content (not just a few words)

Return JSON with this structure:
{
  "scenes": [
    {
      "scriptContent": "The complete text from this section, including dialogue and stage directions",
      "description": "What happens in this scene",
      "duration": 10000,
      "type": "dialogue",
      "intensity": 5
    }
  ],
  "characters": ["Character names"],
  "settings": ["Locations"],
  "themes": ["Main themes"],
  "totalDuration": 30000
}

IMPORTANT RULES:
- scriptContent should be the COMPLETE text from that scene section
- Include stage directions in parentheses, dialogue, everything
- If the script has sections like [0-3s] Hook, extract everything from that section
- Each scene should have meaningful content (aim for 100-500 characters per scene)
- Combine very short sections if needed to create substantial scenes

Respond with ONLY valid JSON.`,
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
