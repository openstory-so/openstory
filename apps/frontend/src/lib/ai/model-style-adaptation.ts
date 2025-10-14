/**
 * Model-specific style stack adaptation
 * Optimizes style configurations for each FAL model's capabilities
 */

import type {
  StyleStackBase,
  StyleStackConfig,
} from "@/lib/schemas/style-stack";

export interface ModelStyleCapabilities {
  supportsComplexLighting: boolean;
  supportsDetailedTextures: boolean;
  supportsAdvancedComposition: boolean;
  supportsColorGrading: boolean;
  supportsCinematicEffects: boolean;
  maxPromptLength: number;
  preferredAspectRatios: string[];
  strengthAreas: string[];
  limitations: string[];
}

export interface AdaptedStyleConfig {
  base: StyleStackBase;
  modelSpecific: {
    additionalPrompt: string;
    negativePrompt: string;
    technicalParams: Record<string, unknown>;
    styleModifications: string[];
  };
  optimizationLevel: "minimal" | "moderate" | "aggressive";
}

export const MODEL_STYLE_CAPABILITIES: Record<string, ModelStyleCapabilities> =
  {
    flux_pro: {
      supportsComplexLighting: true,
      supportsDetailedTextures: true,
      supportsAdvancedComposition: true,
      supportsColorGrading: true,
      supportsCinematicEffects: true,
      maxPromptLength: 200,
      preferredAspectRatios: ["16:9", "4:3", "1:1"],
      strengthAreas: [
        "photorealistic",
        "cinematic",
        "detailed",
        "professional",
      ],
      limitations: ["slower generation", "higher cost"],
    },
    flux_dev: {
      supportsComplexLighting: true,
      supportsDetailedTextures: true,
      supportsAdvancedComposition: true,
      supportsColorGrading: true,
      supportsCinematicEffects: true,
      maxPromptLength: 150,
      preferredAspectRatios: ["16:9", "4:3", "1:1"],
      strengthAreas: ["artistic", "creative", "stylized", "experimental"],
      limitations: ["less photorealistic", "more artistic interpretation"],
    },
    flux_schnell: {
      supportsComplexLighting: false,
      supportsDetailedTextures: false,
      supportsAdvancedComposition: false,
      supportsColorGrading: false,
      supportsCinematicEffects: false,
      maxPromptLength: 100,
      preferredAspectRatios: ["1:1", "4:3"],
      strengthAreas: ["fast", "simple", "clean", "minimal"],
      limitations: ["limited detail", "basic lighting", "simple composition"],
    },
    flux_pro_kontext_max: {
      supportsComplexLighting: true,
      supportsDetailedTextures: true,
      supportsAdvancedComposition: true,
      supportsColorGrading: true,
      supportsCinematicEffects: true,
      maxPromptLength: 250,
      preferredAspectRatios: ["16:9", "4:3", "1:1"],
      strengthAreas: [
        "contextual",
        "scene-aware",
        "consistent",
        "reference-based",
      ],
      limitations: ["requires reference image", "slower processing"],
    },
    imagen4_preview_ultra: {
      supportsComplexLighting: true,
      supportsDetailedTextures: true,
      supportsAdvancedComposition: true,
      supportsColorGrading: true,
      supportsCinematicEffects: true,
      maxPromptLength: 300,
      preferredAspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
      strengthAreas: [
        "ultra-realistic",
        "professional",
        "studio-quality",
        "perfect-lighting",
      ],
      limitations: ["highest cost", "longest generation time"],
    },
    flux_krea_lora: {
      supportsComplexLighting: true,
      supportsDetailedTextures: true,
      supportsAdvancedComposition: true,
      supportsColorGrading: true,
      supportsCinematicEffects: true,
      maxPromptLength: 150,
      preferredAspectRatios: ["16:9", "4:3", "1:1"],
      strengthAreas: ["artistic", "stylized", "creative", "unique-style"],
      limitations: ["artistic interpretation", "less photorealistic"],
    },
    sdxl: {
      supportsComplexLighting: true,
      supportsDetailedTextures: true,
      supportsAdvancedComposition: true,
      supportsColorGrading: true,
      supportsCinematicEffects: true,
      maxPromptLength: 200,
      preferredAspectRatios: ["16:9", "4:3", "1:1"],
      strengthAreas: ["balanced", "reliable", "detailed", "professional"],
      limitations: ["moderate speed", "standard quality"],
    },
    sdxl_lightning: {
      supportsComplexLighting: false,
      supportsDetailedTextures: false,
      supportsAdvancedComposition: false,
      supportsColorGrading: false,
      supportsCinematicEffects: false,
      maxPromptLength: 100,
      preferredAspectRatios: ["1:1", "4:3"],
      strengthAreas: ["fast", "dynamic", "energetic", "high-contrast"],
      limitations: ["limited detail", "basic effects", "simple composition"],
    },
  };

/**
 * Analyzes a style configuration to understand its complexity and requirements
 */
export function analyzeStyleComplexity(styleConfig: StyleStackConfig): {
  complexity: "simple" | "moderate" | "complex";
  lightingComplexity: "basic" | "advanced" | "cinematic";
  textureDetail: "minimal" | "moderate" | "high";
  compositionComplexity: "basic" | "advanced" | "professional";
  colorComplexity: "simple" | "moderate" | "complex";
  effectsLevel: "none" | "basic" | "advanced";
} {
  const base = styleConfig.base;

  // Analyze lighting complexity
  let lightingComplexity: "basic" | "advanced" | "cinematic" = "basic";
  if (
    base.lighting.includes("dramatic") ||
    base.lighting.includes("cinematic") ||
    base.lighting.includes("studio") ||
    base.lighting.includes("key lighting")
  ) {
    lightingComplexity = "cinematic";
  } else if (
    base.lighting.includes("contrast") ||
    base.lighting.includes("shadow") ||
    base.lighting.includes("directional")
  ) {
    lightingComplexity = "advanced";
  }

  // Analyze texture detail
  let textureDetail: "minimal" | "moderate" | "high" = "minimal";
  if (
    base.texture &&
    (base.texture.includes("detailed") ||
      base.texture.includes("high-resolution") ||
      base.texture.includes("intricate") ||
      base.texture.includes("fine"))
  ) {
    textureDetail = "high";
  } else if (
    base.texture &&
    (base.texture.includes("texture") ||
      base.texture.includes("surface") ||
      base.texture.includes("material"))
  ) {
    textureDetail = "moderate";
  }

  // Analyze composition complexity
  let compositionComplexity: "basic" | "advanced" | "professional" = "basic";
  if (
    base.composition &&
    (base.composition.includes("rule of thirds") ||
      base.composition.includes("golden ratio") ||
      base.composition.includes("advanced"))
  ) {
    compositionComplexity = "professional";
  } else if (
    base.composition &&
    (base.composition.includes("composition") ||
      base.composition.includes("framing") ||
      base.composition.includes("balance"))
  ) {
    compositionComplexity = "advanced";
  }

  // Analyze color complexity
  let colorComplexity: "simple" | "moderate" | "complex" = "simple";
  if (
    base.color_palette.includes("gradient") ||
    base.color_palette.includes("multiple") ||
    base.color_palette.includes("complex") ||
    base.color_palette.includes("sophisticated")
  ) {
    colorComplexity = "complex";
  } else if (
    base.color_palette.includes("palette") ||
    base.color_palette.includes("scheme") ||
    base.color_palette.includes("harmony")
  ) {
    colorComplexity = "moderate";
  }

  // Analyze effects level
  let effectsLevel: "none" | "basic" | "advanced" = "none";
  if (
    base.mood.includes("cinematic") ||
    base.mood.includes("dramatic") ||
    base.mood.includes("atmospheric") ||
    base.mood.includes("stylized")
  ) {
    effectsLevel = "advanced";
  } else if (
    base.mood.includes("enhanced") ||
    base.mood.includes("polished") ||
    base.mood.includes("refined")
  ) {
    effectsLevel = "basic";
  }

  // Determine overall complexity
  let complexity: "simple" | "moderate" | "complex" = "simple";
  const complexityFactors = [
    lightingComplexity === "cinematic",
    textureDetail === "high",
    compositionComplexity === "professional",
    colorComplexity === "complex",
    effectsLevel === "advanced",
  ];

  const complexFactors = complexityFactors.filter(Boolean).length;
  if (complexFactors >= 3) {
    complexity = "complex";
  } else if (complexFactors >= 1) {
    complexity = "moderate";
  }

  return {
    complexity,
    lightingComplexity,
    textureDetail,
    compositionComplexity,
    colorComplexity,
    effectsLevel,
  };
}

/**
 * Adapts a style configuration for a specific model
 */
export function adaptStyleForModel(
  styleConfig: StyleStackConfig,
  modelId: string,
): AdaptedStyleConfig | null {
  const capabilities = MODEL_STYLE_CAPABILITIES[modelId];
  if (!capabilities) {
    console.warn(`No style capabilities found for model: ${modelId}`);
    return null;
  }

  const analysis = analyzeStyleComplexity(styleConfig);
  const base = styleConfig.base;

  // Determine optimization level based on model capabilities vs style requirements
  let optimizationLevel: "minimal" | "moderate" | "aggressive" = "minimal";

  if (
    !capabilities.supportsComplexLighting &&
    analysis.lightingComplexity === "cinematic"
  ) {
    optimizationLevel = "aggressive";
  } else if (
    !capabilities.supportsDetailedTextures &&
    analysis.textureDetail === "high"
  ) {
    optimizationLevel = "aggressive";
  } else if (
    !capabilities.supportsAdvancedComposition &&
    analysis.compositionComplexity === "professional"
  ) {
    optimizationLevel = "aggressive";
  } else if (
    analysis.complexity === "complex" &&
    capabilities.strengthAreas.includes("simple")
  ) {
    optimizationLevel = "moderate";
  }

  // Create adapted base configuration
  const adaptedBase: StyleStackBase = { ...base };

  // Apply model-specific modifications
  const styleModifications: string[] = [];
  const additionalPromptParts: string[] = [];
  const negativePromptParts: string[] = [];
  const technicalParams: Record<string, unknown> = {};

  // Lighting adaptations
  if (
    !capabilities.supportsComplexLighting &&
    analysis.lightingComplexity !== "basic"
  ) {
    adaptedBase.lighting = "natural lighting, soft shadows, even illumination";
    styleModifications.push("simplified lighting for model compatibility");
    negativePromptParts.push(
      "dramatic lighting",
      "harsh shadows",
      "complex lighting setup",
    );
  } else if (
    capabilities.supportsComplexLighting &&
    analysis.lightingComplexity === "cinematic"
  ) {
    additionalPromptParts.push(
      "cinematic lighting",
      "professional lighting setup",
    );
  }

  // Texture adaptations
  if (
    !capabilities.supportsDetailedTextures &&
    analysis.textureDetail !== "minimal"
  ) {
    adaptedBase.texture = "clean surfaces, smooth textures";
    styleModifications.push("simplified textures for model compatibility");
    negativePromptParts.push(
      "highly detailed textures",
      "intricate surface details",
    );
  } else if (
    capabilities.supportsDetailedTextures &&
    analysis.textureDetail === "high"
  ) {
    additionalPromptParts.push(
      "highly detailed textures",
      "intricate surface details",
    );
  }

  // Composition adaptations
  if (
    !capabilities.supportsAdvancedComposition &&
    analysis.compositionComplexity !== "basic"
  ) {
    adaptedBase.composition = "simple composition, centered framing";
    styleModifications.push("simplified composition for model compatibility");
    negativePromptParts.push("complex composition", "advanced framing");
  } else if (
    capabilities.supportsAdvancedComposition &&
    analysis.compositionComplexity === "professional"
  ) {
    additionalPromptParts.push(
      "professional composition",
      "advanced framing techniques",
    );
  }

  // Color adaptations
  if (
    !capabilities.supportsColorGrading &&
    analysis.colorComplexity !== "simple"
  ) {
    adaptedBase.color_palette = "natural colors, balanced palette";
    styleModifications.push("simplified color palette for model compatibility");
    negativePromptParts.push(
      "complex color grading",
      "sophisticated color schemes",
    );
  } else if (
    capabilities.supportsColorGrading &&
    analysis.colorComplexity === "complex"
  ) {
    additionalPromptParts.push(
      "sophisticated color grading",
      "complex color harmony",
    );
  }

  // Effects adaptations
  if (
    !capabilities.supportsCinematicEffects &&
    analysis.effectsLevel !== "none"
  ) {
    adaptedBase.mood = base.mood.replace(
      /cinematic|dramatic|atmospheric/g,
      "enhanced",
    );
    styleModifications.push("simplified effects for model compatibility");
    negativePromptParts.push("cinematic effects", "dramatic atmosphere");
  } else if (
    capabilities.supportsCinematicEffects &&
    analysis.effectsLevel === "advanced"
  ) {
    additionalPromptParts.push("cinematic effects", "dramatic atmosphere");
  }

  // Model-specific technical parameters
  if (modelId === "flux_pro" || modelId === "flux_pro_kontext_max") {
    technicalParams.guidance_scale =
      analysis.complexity === "complex" ? 8.0 : 7.5;
    technicalParams.steps = analysis.complexity === "complex" ? 30 : 25;
  } else if (modelId === "imagen4_preview_ultra") {
    technicalParams.guidance_scale = 7.5;
    technicalParams.aspect_ratio = capabilities.preferredAspectRatios[0];
  } else if (modelId === "flux_schnell" || modelId === "sdxl_lightning") {
    technicalParams.guidance_scale = 6.0;
    technicalParams.steps = 15;
  }

  // Build final prompts
  const additionalPrompt =
    additionalPromptParts.length > 0 ? additionalPromptParts.join(", ") : "";

  const negativePrompt =
    negativePromptParts.length > 0
      ? negativePromptParts.join(", ")
      : "blurry, low quality, distorted, poorly composed";

  return {
    base: adaptedBase,
    modelSpecific: {
      additionalPrompt,
      negativePrompt,
      technicalParams,
      styleModifications,
    },
    optimizationLevel,
  };
}

/**
 * Gets model-specific style recommendations
 */
export function getModelStyleRecommendations(modelId: string): {
  recommendedCategories: string[];
  recommendedTags: string[];
  avoidCategories: string[];
  avoidTags: string[];
  optimalComplexity: "simple" | "moderate" | "complex";
} {
  const capabilities = MODEL_STYLE_CAPABILITIES[modelId];
  if (!capabilities) {
    return {
      recommendedCategories: [],
      recommendedTags: [],
      avoidCategories: [],
      avoidTags: [],
      optimalComplexity: "simple",
    };
  }

  const recommendedCategories: string[] = [];
  const recommendedTags: string[] = [];
  const avoidCategories: string[] = [];
  const avoidTags: string[] = [];

  // Base recommendations on model strengths
  if (capabilities.strengthAreas.includes("photorealistic")) {
    recommendedCategories.push("cinematic", "documentary", "commercial");
    recommendedTags.push("realistic", "professional", "sharp", "detailed");
  }

  if (capabilities.strengthAreas.includes("artistic")) {
    recommendedCategories.push("artistic", "animation", "music_video");
    recommendedTags.push("artistic", "creative", "stylized", "vibrant");
  }

  if (capabilities.strengthAreas.includes("fast")) {
    recommendedCategories.push("minimal", "commercial");
    recommendedTags.push("simple", "clean", "minimal", "fast");
    avoidCategories.push("cinematic", "noir", "fantasy");
    avoidTags.push("complex", "detailed", "cinematic", "dramatic");
  }

  // Avoid complex styles for limited models
  if (!capabilities.supportsComplexLighting) {
    avoidTags.push("dramatic", "high-contrast", "cinematic");
  }

  if (!capabilities.supportsDetailedTextures) {
    avoidTags.push("detailed", "textured", "intricate");
  }

  if (!capabilities.supportsAdvancedComposition) {
    avoidTags.push("professional", "advanced", "complex");
  }

  // Determine optimal complexity
  let optimalComplexity: "simple" | "moderate" | "complex" = "simple";
  if (
    capabilities.supportsComplexLighting &&
    capabilities.supportsDetailedTextures &&
    capabilities.supportsAdvancedComposition
  ) {
    optimalComplexity = "complex";
  } else if (
    capabilities.supportsComplexLighting ||
    capabilities.supportsDetailedTextures
  ) {
    optimalComplexity = "moderate";
  }

  return {
    recommendedCategories,
    recommendedTags,
    avoidCategories,
    avoidTags,
    optimalComplexity,
  };
}

/**
 * Validates if a style is compatible with a model
 */
export function validateStyleModelCompatibility(
  styleConfig: StyleStackConfig,
  modelId: string,
): {
  compatible: boolean;
  issues: string[];
  recommendations: string[];
} {
  const capabilities = MODEL_STYLE_CAPABILITIES[modelId];
  const analysis = analyzeStyleComplexity(styleConfig);
  const issues: string[] = [];
  const recommendations: string[] = [];

  if (!capabilities) {
    return {
      compatible: false,
      issues: [`Model ${modelId} not supported`],
      recommendations: ["Use a supported model"],
    };
  }

  // Check lighting compatibility
  if (
    !capabilities.supportsComplexLighting &&
    analysis.lightingComplexity === "cinematic"
  ) {
    issues.push("Model does not support complex lighting requirements");
    recommendations.push("Simplify lighting to basic or natural lighting");
  }

  // Check texture compatibility
  if (
    !capabilities.supportsDetailedTextures &&
    analysis.textureDetail === "high"
  ) {
    issues.push("Model does not support high-detail texture requirements");
    recommendations.push("Reduce texture complexity to moderate or minimal");
  }

  // Check composition compatibility
  if (
    !capabilities.supportsAdvancedComposition &&
    analysis.compositionComplexity === "professional"
  ) {
    issues.push("Model does not support advanced composition requirements");
    recommendations.push("Simplify composition to basic or advanced level");
  }

  // Check prompt length
  const totalPromptLength = Object.values(styleConfig.base).join(" ").length;
  if (totalPromptLength > capabilities.maxPromptLength) {
    issues.push(
      `Style prompt too long for model (${totalPromptLength} > ${capabilities.maxPromptLength})`,
    );
    recommendations.push(
      "Shorten style descriptions and remove unnecessary details",
    );
  }

  return {
    compatible: issues.length === 0,
    issues,
    recommendations,
  };
}
