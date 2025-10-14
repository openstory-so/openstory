import { faker } from "@faker-js/faker";
import { DELAYS } from "@/app/actions/anonymous-flow/index.mock";

// Set consistent seed for reproducible results
faker.seed(456);

/**
 * Validate script and provide feedback
 */

interface ScriptValidationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  estimatedFrames: number;
  estimatedDuration: number; // in seconds
} // Mock script enhancement response

// Mock script enhancement response
interface ScriptEnhancementResult {
  success: boolean;
  originalScript: string;
  enhancedScript: string;
  improvements: string[];
  error?: string;
}

export async function validateScript(
  script: string,
): Promise<ScriptValidationResult> {
  // Simulate processing time
  await new Promise((resolve) => setTimeout(resolve, DELAYS.SCRIPT_VALIDATION));

  const trimmedScript = script.trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Basic validation
  if (!trimmedScript) {
    errors.push("Script cannot be empty");
  } else if (trimmedScript.length < 10) {
    errors.push("Script must be at least 10 characters long");
  } else if (trimmedScript.length > 10000) {
    errors.push("Script must be 10,000 characters or less");
  }

  // Content warnings and suggestions
  if (trimmedScript.length > 0) {
    const wordCount = trimmedScript.split(/\s+/).length;
    const sentenceCount = trimmedScript
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0).length;

    if (wordCount < 50) {
      warnings.push("Short scripts may generate fewer frames");
    }

    if (wordCount > 500) {
      warnings.push("Long scripts may take more time to process");
    }

    if (sentenceCount < 3) {
      suggestions.push("Consider adding more detail for richer visuals");
    }

    if (!trimmedScript.match(/[.!?]/)) {
      suggestions.push("Add punctuation to help identify scene breaks");
    }

    // Check for dialogue
    if (trimmedScript.includes('"') || trimmedScript.includes("'")) {
      suggestions.push(
        "Dialogue detected - consider describing character expressions",
      );
    }

    // Check for action words
    const actionWords = [
      "runs",
      "jumps",
      "fights",
      "flies",
      "explodes",
      "crashes",
    ];
    const hasAction = actionWords.some((word) =>
      trimmedScript.toLowerCase().includes(word),
    );

    if (hasAction) {
      suggestions.push(
        "Action sequences detected - great for dynamic visuals!",
      );
    }
  }

  // Estimate frames and duration
  const estimatedFrames =
    errors.length > 0 ? 0 : Math.max(1, Math.ceil(trimmedScript.length / 100));
  const estimatedDuration = estimatedFrames * 5; // 5 seconds per frame

  return {
    success: errors.length === 0,
    errors,
    warnings,
    suggestions,
    estimatedFrames,
    estimatedDuration,
  };
} // Mock script validation response

/**
 * Enhance script with AI suggestions (mock)
 */
export async function enhanceScript(
  originalScript: string,
): Promise<ScriptEnhancementResult> {
  // Simulate processing time
  await new Promise((resolve) =>
    setTimeout(resolve, DELAYS.SCRIPT_ENHANCEMENT),
  );

  const trimmedScript = originalScript.trim();

  if (!trimmedScript) {
    return {
      success: false,
      originalScript,
      enhancedScript: originalScript,
      improvements: [],
      error: "Cannot enhance empty script",
    };
  }

  // Mock enhancement logic
  let enhancedScript = trimmedScript;
  const improvements: string[] = [];

  // Add visual details
  if (
    !enhancedScript.includes("lighting") &&
    !enhancedScript.includes("light")
  ) {
    const lightingOptions = [
      "golden sunlight",
      "soft ambient lighting",
      "dramatic shadows",
      "neon glow",
    ];
    const lighting = faker.helpers.arrayElement(lightingOptions);
    enhancedScript = enhancedScript.replace(/\.$/, `, bathed in ${lighting}.`);
    improvements.push("Added lighting description");
  }

  // Enhance character descriptions
  if (
    enhancedScript.includes("person") ||
    enhancedScript.includes("character")
  ) {
    const emotions = [
      "determined",
      "anxious",
      "hopeful",
      "contemplative",
      "focused",
    ];
    const emotion = faker.helpers.arrayElement(emotions);
    enhancedScript = enhancedScript.replace(
      /(person|character)/gi,
      `$1 with a ${emotion} expression`,
    );
    improvements.push("Enhanced character emotions");
  }

  // Add setting details
  if (
    !enhancedScript.includes("background") &&
    !enhancedScript.includes("setting")
  ) {
    const settings = [
      "bustling cityscape",
      "serene natural landscape",
      "modern interior space",
      "vintage atmosphere",
    ];
    const setting = faker.helpers.arrayElement(settings);
    enhancedScript += ` The scene unfolds against a ${setting}.`;
    improvements.push("Added setting description");
  }

  // Add camera angle suggestions
  if (
    !enhancedScript.toLowerCase().includes("shot") &&
    !enhancedScript.toLowerCase().includes("angle")
  ) {
    const angles = [
      "wide establishing shot",
      "intimate close-up",
      "dynamic low angle",
      "cinematic medium shot",
    ];
    const angle = faker.helpers.arrayElement(angles);
    enhancedScript = `${angle.charAt(0).toUpperCase() + angle.slice(1)}: ${enhancedScript}`;
    improvements.push("Added cinematography direction");
  }

  return {
    success: true,
    originalScript,
    enhancedScript,
    improvements,
  };
}
