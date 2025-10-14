/**
 * Frame generation service
 * Divides script into chunks for storyboard frames
 */

import { DNADirectorProcessor } from "@/lib/services/dna-director/dna-director.service";

export interface GenerateFrameDescriptionsParams {
  scriptAnalysis: {
    scenes: Array<{
      scriptContent: string; // The actual script text for this scene
      description: string;
      duration?: number;
      type?: string;
      intensity?: number;
    }>;
    characters?: string[];
    settings?: string[];
  };
  styleId?: string;
  aiProvider?: "openai" | "anthropic" | "openrouter";
}

export interface FrameDescriptionResult {
  frames: Array<{
    description: string; // This will be the script chunk
    orderIndex: number;
    durationMs: number;
    metadata: {
      scene: number;
      scriptChunk: string;
      shotType?: string;
      sceneType?: string;
      sceneIntensity?: number;
      characters?: string[];
      settings?: string[];
    };
  }>;
  totalDuration: number;
  frameCount: number;
}

/**
 * Generate frames by dividing script into chunks
 */
export async function generateFrameDescriptions(
  params: GenerateFrameDescriptionsParams,
): Promise<FrameDescriptionResult> {
  const { scriptAnalysis, styleId } = params;

  const frames: FrameDescriptionResult["frames"] = [];
  let orderIndex = 0;
  let totalDuration = 0;

  // Define shot types to cycle through
  const shotTypes = [
    "wide shot",
    "medium shot",
    "close-up",
    "medium shot",
    "wide shot",
  ];

  // Apply DNA Director to the prompt
  let sceneScripts: string[] = [];

  // Apply DNA Director if styleId exists
  if (styleId) {
    const BATCH_SIZE = 5; // Process 5 scenes at a time to avoid rate limits
    const allResults: PromiseSettledResult<
      Awaited<ReturnType<typeof DNADirectorProcessor>>
    >[] = [];

    // Process scenes in batches
    for (let i = 0; i < scriptAnalysis.scenes.length; i += BATCH_SIZE) {
      const batch = scriptAnalysis.scenes.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((scene) =>
        DNADirectorProcessor(styleId, scene.scriptContent || ""),
      );
      const batchResults = await Promise.allSettled(batchPromises);
      allResults.push(...batchResults);
    }

    sceneScripts = scriptAnalysis.scenes.map((scene, index) => {
      const dnaResult = allResults[index];
      if (dnaResult.status === "fulfilled" && dnaResult.value.status) {
        return dnaResult.value.data?.message || scene.scriptContent || "";
      }
      return scene.scriptContent || "";
    });
  } else {
    sceneScripts = scriptAnalysis.scenes.map((s) => s.scriptContent || "");
  }

  // Then use results in the loop
  for (
    let sceneIndex = 0;
    sceneIndex < scriptAnalysis.scenes.length;
    sceneIndex++
  ) {
    const scene = scriptAnalysis.scenes[sceneIndex];
    const sceneScript = sceneScripts[sceneIndex];
    const sceneDuration = scene.duration || 10000;

    // Skip empty scenes
    if (!sceneScript || sceneScript.trim().length === 0) {
      continue;
    }

    // Use the ENTIRE scene content for the frame
    frames.push({
      description: sceneScript, // Use complete scene text as description
      orderIndex: orderIndex++,
      durationMs: Math.round(sceneDuration),
      metadata: {
        scene: sceneIndex,
        scriptChunk: sceneScript, // Store complete scene text
        shotType: shotTypes[sceneIndex % shotTypes.length],
        sceneType: scene.type,
        sceneIntensity: scene.intensity,
        characters: scriptAnalysis.characters?.slice(0, 2),
        settings: scriptAnalysis.settings?.slice(0, 1),
      },
    });
    totalDuration += sceneDuration;
  }

  return {
    frames,
    totalDuration,
    frameCount: frames.length,
  };
}
