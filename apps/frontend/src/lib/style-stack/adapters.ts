import type {
  FluxProConfig,
  Imagen4Config,
  KlingConfig,
  RunwayConfig,
  StyleStackConfig,
} from "@/lib/schemas/style-stack";

// Base adapter interface
export interface ModelAdapter<TConfig = Record<string, unknown>> {
  provider: string;
  modelName: string;
  adaptStyle(styleConfig: StyleStackConfig): TConfig;
  validateConfig(config: TConfig): boolean;
}

// Flux Pro adapter
export class FluxProAdapter
  implements ModelAdapter<FluxProConfig & { prompt: string }>
{
  provider = "fal";
  modelName = "flux-pro";

  adaptStyle(
    styleConfig: StyleStackConfig,
  ): FluxProConfig & { prompt: string } {
    const base = styleConfig.base;
    const fluxConfig = styleConfig.models?.["flux-pro"];

    // Build comprehensive prompt from base style
    const promptParts = [
      `${base.mood} mood`,
      base.lighting,
      base.color_palette,
      base.camera,
    ];

    if (base.composition) {
      promptParts.push(base.composition);
    }
    if (base.texture) {
      promptParts.push(base.texture);
    }
    if (base.environment) {
      promptParts.push(base.environment);
    }

    // Add model-specific prompt additions
    if (fluxConfig?.additional_prompt) {
      promptParts.push(fluxConfig.additional_prompt);
    }

    const prompt = promptParts.join(", ");

    return {
      prompt,
      additional_prompt: fluxConfig?.additional_prompt || "",
      negative_prompt:
        fluxConfig?.negative_prompt || this.getDefaultNegativePrompt(base),
      guidance_scale: fluxConfig?.guidance_scale || 7.5,
      steps: fluxConfig?.steps || 20,
    };
  }

  private getDefaultNegativePrompt(base: StyleStackConfig["base"]): string {
    const negatives = ["low quality", "blurry", "distorted"];

    // Add contextual negatives based on style
    if (base.mood.includes("dark") || base.mood.includes("noir")) {
      negatives.push("bright", "cheerful", "colorful");
    }
    if (
      base.color_palette.includes("monochrome") ||
      base.color_palette.includes("black and white")
    ) {
      negatives.push("colorful", "vibrant colors");
    }
    if (base.mood.includes("minimal") || base.mood.includes("clean")) {
      negatives.push("cluttered", "busy", "complex");
    }

    return negatives.join(", ");
  }

  validateConfig(config: FluxProConfig & { prompt: string }): boolean {
    return (
      typeof config.prompt === "string" &&
      config.prompt.length > 0 &&
      typeof config.guidance_scale === "number" &&
      config.guidance_scale >= 1 &&
      config.guidance_scale <= 20 &&
      typeof config.steps === "number" &&
      config.steps >= 10 &&
      config.steps <= 50
    );
  }
}

// Imagen4 adapter
export class Imagen4Adapter
  implements ModelAdapter<Imagen4Config & { prompt: string }>
{
  provider = "google";
  modelName = "imagen4";

  adaptStyle(
    styleConfig: StyleStackConfig,
  ): Imagen4Config & { prompt: string } {
    const base = styleConfig.base;
    const imagen4Config = styleConfig.models?.imagen4;

    // Build prompt optimized for Imagen4
    const promptParts = [
      this.adaptMoodForImagen4(base.mood),
      this.adaptLightingForImagen4(base.lighting),
      base.color_palette,
      this.adaptCameraForImagen4(base.camera),
    ];

    if (base.environment) {
      promptParts.push(base.environment);
    }

    const prompt = promptParts.join(", ");

    return {
      prompt,
      style_preset:
        imagen4Config?.style_preset || this.inferStylePreset(styleConfig),
      guidance_scale: imagen4Config?.guidance_scale || 7.5,
      aspect_ratio: imagen4Config?.aspect_ratio || "16:9",
    };
  }

  private adaptMoodForImagen4(mood: string): string {
    // Imagen4 responds well to specific artistic terms
    return mood
      .replace(/noir/g, "film noir aesthetic")
      .replace(/dramatic/g, "cinematic drama")
      .replace(/minimal/g, "minimalist composition");
  }

  private adaptLightingForImagen4(lighting: string): string {
    // Imagen4 lighting adaptations
    return lighting
      .replace(/rim lighting/g, "edge lighting")
      .replace(/practical lights/g, "source lighting")
      .replace(/chiaroscuro/g, "strong light-shadow contrast");
  }

  private adaptCameraForImagen4(camera: string): string {
    // Imagen4 camera term adaptations
    return camera
      .replace(/dutch tilt/g, "tilted camera angle")
      .replace(/low angle/g, "worm's eye view")
      .replace(/high angle/g, "bird's eye view");
  }

  private inferStylePreset(styleConfig: StyleStackConfig): string {
    const category = styleConfig.base.mood.toLowerCase();

    if (category.includes("cinematic") || category.includes("film"))
      return "cinematic";
    if (category.includes("artistic") || category.includes("art"))
      return "artistic";
    if (category.includes("photo") || category.includes("realistic"))
      return "photographic";
    if (category.includes("minimal")) return "minimal";
    if (category.includes("vintage") || category.includes("retro"))
      return "vintage";
    if (category.includes("fantasy") || category.includes("magical"))
      return "fantasy";

    return "cinematic"; // Default fallback
  }

  validateConfig(config: Imagen4Config & { prompt: string }): boolean {
    const validAspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4"];

    return (
      typeof config.prompt === "string" &&
      config.prompt.length > 0 &&
      typeof config.guidance_scale === "number" &&
      config.guidance_scale >= 1 &&
      config.guidance_scale <= 20 &&
      validAspectRatios.includes(config.aspect_ratio)
    );
  }
}

// Runway adapter
export class RunwayAdapter
  implements ModelAdapter<RunwayConfig & { prompt: string }>
{
  provider = "runway";
  modelName = "gen3";

  adaptStyle(styleConfig: StyleStackConfig): RunwayConfig & { prompt: string } {
    const base = styleConfig.base;
    const runwayConfig = styleConfig.models?.runway;

    // Build prompt with motion considerations
    const promptParts = [
      base.mood,
      this.adaptLightingForVideo(base.lighting),
      base.color_palette,
      this.adaptCameraForVideo(base.camera),
    ];

    if (base.environment) {
      promptParts.push(base.environment);
    }

    // Add motion descriptors based on style
    promptParts.push(this.inferMotionStyle(base));

    const prompt = promptParts.join(", ");

    return {
      prompt,
      motion_strength:
        runwayConfig?.motion_strength || this.inferMotionStrength(base),
      camera_motion:
        runwayConfig?.camera_motion || this.inferCameraMotion(base),
      duration: runwayConfig?.duration || 3,
    };
  }

  private adaptLightingForVideo(lighting: string): string {
    // Video-specific lighting adaptations
    return lighting
      .replace(/high contrast/g, "dynamic lighting contrast")
      .replace(/soft shadows/g, "gentle shadow movement");
  }

  private adaptCameraForVideo(camera: string): string {
    // Video camera movement adaptations
    return camera
      .replace(/close-ups/g, "intimate framing with subtle movement")
      .replace(/wide shots/g, "expansive cinematic framing");
  }

  private inferMotionStyle(base: StyleStackConfig["base"]): string {
    if (base.mood.includes("dynamic") || base.mood.includes("energetic")) {
      return "dynamic movement, flowing motion";
    }
    if (base.mood.includes("calm") || base.mood.includes("peaceful")) {
      return "gentle movement, subtle motion";
    }
    if (base.mood.includes("dramatic")) {
      return "cinematic movement, purposeful motion";
    }
    return "natural movement";
  }

  private inferMotionStrength(base: StyleStackConfig["base"]): number {
    if (base.mood.includes("dynamic") || base.mood.includes("energetic"))
      return 8;
    if (base.mood.includes("dramatic")) return 6;
    if (base.mood.includes("calm") || base.mood.includes("minimal")) return 3;
    return 5; // Default medium motion
  }

  private inferCameraMotion(
    base: StyleStackConfig["base"],
  ): RunwayConfig["camera_motion"] {
    if (base.camera.includes("zoom")) return "zoom_in";
    if (base.camera.includes("pan")) return "pan_right";
    if (base.mood.includes("epic") || base.mood.includes("dramatic"))
      return "zoom_out";
    return "static"; // Default
  }

  validateConfig(config: RunwayConfig & { prompt: string }): boolean {
    const validCameraMotions = [
      "static",
      "pan_left",
      "pan_right",
      "zoom_in",
      "zoom_out",
    ];

    return (
      typeof config.prompt === "string" &&
      config.prompt.length > 0 &&
      typeof config.motion_strength === "number" &&
      config.motion_strength >= 0 &&
      config.motion_strength <= 10 &&
      validCameraMotions.includes(config.camera_motion) &&
      typeof config.duration === "number" &&
      config.duration >= 1 &&
      config.duration <= 10
    );
  }
}

// Kling adapter
export class KlingAdapter
  implements ModelAdapter<KlingConfig & { prompt: string }>
{
  provider = "kling";
  modelName = "v1";

  adaptStyle(styleConfig: StyleStackConfig): KlingConfig & { prompt: string } {
    const base = styleConfig.base;
    const klingConfig = styleConfig.models?.kling;

    // Build prompt optimized for Kling's capabilities
    const promptParts = [
      this.adaptMoodForKling(base.mood),
      base.lighting,
      this.adaptColorForKling(base.color_palette),
      base.camera,
    ];

    if (base.composition) {
      promptParts.push(base.composition);
    }
    if (base.environment) {
      promptParts.push(base.environment);
    }

    const prompt = promptParts.join(", ");

    return {
      prompt,
      creativity: klingConfig?.creativity || this.inferCreativity(base),
      motion_strength:
        klingConfig?.motion_strength || this.inferMotionStrength(base),
      quality: klingConfig?.quality || "high",
    };
  }

  private adaptMoodForKling(mood: string): string {
    // Kling-specific mood adaptations
    return mood
      .replace(/cinematic/g, "movie-like")
      .replace(/atmospheric/g, "immersive atmosphere");
  }

  private adaptColorForKling(colorPalette: string): string {
    // Kling responds well to specific color terms
    return colorPalette
      .replace(/neon/g, "bright neon colors")
      .replace(/monochrome/g, "black and white tones");
  }

  private inferCreativity(base: StyleStackConfig["base"]): number {
    if (base.mood.includes("fantasy") || base.mood.includes("surreal"))
      return 0.9;
    if (base.mood.includes("artistic") || base.mood.includes("experimental"))
      return 0.8;
    if (base.mood.includes("realistic") || base.mood.includes("documentary"))
      return 0.4;
    if (base.mood.includes("commercial") || base.mood.includes("professional"))
      return 0.3;
    return 0.7; // Default moderate creativity
  }

  private inferMotionStrength(base: StyleStackConfig["base"]): number {
    if (base.mood.includes("dynamic") || base.mood.includes("energetic"))
      return 0.8;
    if (base.mood.includes("dramatic")) return 0.6;
    if (base.mood.includes("calm") || base.mood.includes("minimal")) return 0.3;
    return 0.5; // Default medium motion
  }

  validateConfig(config: KlingConfig & { prompt: string }): boolean {
    const validQualities = ["standard", "high"];

    return (
      typeof config.prompt === "string" &&
      config.prompt.length > 0 &&
      typeof config.creativity === "number" &&
      config.creativity >= 0 &&
      config.creativity <= 1 &&
      typeof config.motion_strength === "number" &&
      config.motion_strength >= 0 &&
      config.motion_strength <= 1 &&
      validQualities.includes(config.quality)
    );
  }
}

// Registry of available adapters
export class ModelAdapterRegistry {
  private adapters = new Map<string, ModelAdapter>();

  constructor() {
    this.registerAdapter(new FluxProAdapter());
    this.registerAdapter(new Imagen4Adapter());
    this.registerAdapter(new RunwayAdapter());
    this.registerAdapter(new KlingAdapter());
  }

  registerAdapter(adapter: ModelAdapter): void {
    const key = `${adapter.provider}:${adapter.modelName}`;
    this.adapters.set(key, adapter);
  }

  getAdapter(provider: string, modelName: string): ModelAdapter | null {
    const key = `${provider}:${modelName}`;
    return this.adapters.get(key) || null;
  }

  getAvailableModels(): Array<{ provider: string; modelName: string }> {
    return Array.from(this.adapters.values()).map((adapter) => ({
      provider: adapter.provider,
      modelName: adapter.modelName,
    }));
  }

  adaptStyleForModel(
    styleConfig: StyleStackConfig,
    provider: string,
    modelName: string,
  ): Record<string, unknown> | null {
    const adapter = this.getAdapter(provider, modelName);
    if (!adapter) {
      return null;
    }

    try {
      const adaptedConfig = adapter.adaptStyle(styleConfig);

      // Validate the adapted configuration
      if (!adapter.validateConfig(adaptedConfig)) {
        console.warn(
          `Invalid adapted configuration for ${provider}:${modelName}`,
        );
        return null;
      }

      return adaptedConfig;
    } catch (error) {
      console.error(
        `Failed to adapt style for ${provider}:${modelName}:`,
        error,
      );
      return null;
    }
  }
}

// Export singleton instance
export const modelAdapterRegistry = new ModelAdapterRegistry();

// Utility function to get adapted configuration
export function getAdaptedStyleConfig(
  styleConfig: StyleStackConfig,
  provider: string,
  modelName: string,
): Record<string, unknown> | null {
  return modelAdapterRegistry.adaptStyleForModel(
    styleConfig,
    provider,
    modelName,
  );
}

// Utility function to generate all adaptations for a style
export async function generateAllAdaptations(
  styleConfig: StyleStackConfig,
): Promise<
  Array<{
    provider: string;
    modelName: string;
    config: Record<string, unknown>;
  }>
> {
  const availableModels = modelAdapterRegistry.getAvailableModels();
  const adaptations = [];

  for (const { provider, modelName } of availableModels) {
    const adaptedConfig = modelAdapterRegistry.adaptStyleForModel(
      styleConfig,
      provider,
      modelName,
    );

    if (adaptedConfig) {
      adaptations.push({
        provider,
        modelName,
        config: adaptedConfig,
      });
    }
  }

  return adaptations;
}
