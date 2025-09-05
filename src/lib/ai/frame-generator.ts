/**
 * Frame generation service
 * Divides script into chunks for storyboard frames
 */

import type { Json } from "@/types/database";

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
  styleStack?: Json;
  framesPerScene?: number;
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
      scriptStart: number; // Position within the scene
      scriptEnd: number; // Position within the scene
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
  const { scriptAnalysis, framesPerScene = 5 } = params;

  const frames: FrameDescriptionResult["frames"] = [];
  let orderIndex = 0;
  let totalDuration = 0;

  // Process each scene
  for (
    let sceneIndex = 0;
    sceneIndex < scriptAnalysis.scenes.length;
    sceneIndex++
  ) {
    const scene = scriptAnalysis.scenes[sceneIndex];
    const sceneScript = scene.scriptContent || "";
    const sceneDuration = scene.duration || 10000; // Default 10 seconds per scene
    const frameDuration = sceneDuration / framesPerScene;

    // Divide the scene script into chunks for frames
    const chunkSize = Math.ceil(sceneScript.length / framesPerScene);

    // Generate frames for this scene
    for (let frameIndex = 0; frameIndex < framesPerScene; frameIndex++) {
      // Extract script chunk for this frame
      const frameScriptStart = frameIndex * chunkSize;
      const frameScriptEnd = Math.min(
        frameScriptStart + chunkSize,
        sceneScript.length,
      );
      const frameScriptChunk = sceneScript.slice(
        frameScriptStart,
        frameScriptEnd,
      );

      // Skip empty chunks
      if (!frameScriptChunk || frameScriptChunk.trim().length === 0) {
        continue;
      }

      // Define basic shot types that cycle through frames
      const shotTypes = [
        "wide shot",
        "medium shot",
        "close-up",
        "medium shot",
        "wide shot",
      ];
      const shotType = shotTypes[frameIndex % shotTypes.length];

      frames.push({
        description: frameScriptChunk, // Use script chunk as description
        orderIndex: orderIndex++,
        durationMs: Math.round(frameDuration),
        metadata: {
          scene: sceneIndex,
          scriptChunk: frameScriptChunk,
          scriptStart: frameScriptStart,
          scriptEnd: frameScriptEnd,
          shotType,
          sceneType: scene.type,
          sceneIntensity: scene.intensity,
          characters: scriptAnalysis.characters?.slice(0, 2),
          settings: scriptAnalysis.settings?.slice(0, 1),
        },
      });

      totalDuration += frameDuration;
    }
  }

  return {
    frames,
    totalDuration,
    frameCount: frames.length,
  };
}
