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
        `Analyze this script and divide it into logical scenes for storyboard generation.

Script:
${script}

Your task: Extract complete sections from the script, preserving ALL content.

For video scripts with marked sections (like ### [0-3s] Hook), use those EXACT sections as scenes.
For each marked section, include:
- The section header (if present)
- ALL stage directions (text in parentheses/italics)
- ALL dialogue
- Everything between one section header and the next

Return JSON with this structure:
{
  "scenes": [
    {
      "scriptContent": "*(Stage direction)* Complete dialogue and all text from this section",
      "description": "Brief summary",
      "duration": 3000,
      "type": "dialogue",
      "intensity": 5
    }
  ],
  "characters": ["Character names"],
  "settings": ["Locations"],
  "themes": ["Main themes"],
  "totalDuration": 30000
}

CRITICAL: 
- Extract EVERYTHING between section markers, including stage directions like *(Playful tone, pet visible)*
- scriptContent must include both the stage directions AND the dialogue
- Don't just extract dialogue - get the FULL section content
- If you see "*(Animated, gesturing to pet)*" followed by dialogue, include BOTH

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
