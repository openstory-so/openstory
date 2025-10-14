import { beforeEach, describe, expect, it } from "bun:test";
import type { StyleStackConfig } from "../../schemas/style-stack";
import {
  FluxProAdapter,
  generateAllAdaptations,
  getAdaptedStyleConfig,
  Imagen4Adapter,
  KlingAdapter,
  ModelAdapterRegistry,
  modelAdapterRegistry,
  RunwayAdapter,
} from "../adapters";

const mockStyleConfig: StyleStackConfig = {
  version: "1.0",
  name: "Test Cinematic Noir",
  base: {
    mood: "dark, mysterious, dramatic",
    lighting: "high contrast, sharp shadows, rim lighting",
    color_palette: "black and white with red accents",
    camera: "low angles, dutch tilts, close-ups",
    composition: "rule of thirds, leading lines",
    texture: "film grain, high contrast",
    environment: "urban nighttime, rain-slicked streets",
  },
  models: {
    "flux-pro": {
      additional_prompt: "film noir style, 1940s cinema",
      negative_prompt: "colorful, bright, cheerful",
      guidance_scale: 8.0,
      steps: 25,
    },
    imagen4: {
      style_preset: "cinematic",
      guidance_scale: 7.5,
      aspect_ratio: "16:9",
    },
    runway: {
      motion_strength: 6,
      camera_motion: "pan_left",
      duration: 4,
    },
    kling: {
      creativity: 0.8,
      motion_strength: 0.6,
      quality: "high",
    },
  },
};

describe("FluxProAdapter", () => {
  let adapter: FluxProAdapter;

  beforeEach(() => {
    adapter = new FluxProAdapter();
  });

  it("should have correct provider and model name", () => {
    expect(adapter.provider).toBe("fal");
    expect(adapter.modelName).toBe("flux-pro");
  });

  it("should adapt style configuration correctly", () => {
    const adapted = adapter.adaptStyle(mockStyleConfig);

    expect(adapted).toHaveProperty("prompt");
    expect(adapted.prompt).toContain("dark, mysterious, dramatic mood");
    expect(adapted.prompt).toContain("high contrast, sharp shadows");
    expect(adapted.prompt).toContain("film noir style, 1940s cinema");

    expect(adapted.additional_prompt).toBe("film noir style, 1940s cinema");
    expect(adapted.negative_prompt).toBe("colorful, bright, cheerful");
    expect(adapted.guidance_scale).toBe(8.0);
    expect(adapted.steps).toBe(25);
  });

  it("should generate default negative prompt based on style", () => {
    const minimalStyle: StyleStackConfig = {
      version: "1.0",
      name: "Test",
      base: {
        mood: "dark, noir",
        lighting: "dramatic",
        color_palette: "monochrome",
        camera: "low angle",
      },
      models: {},
    };

    const adapted = adapter.adaptStyle(minimalStyle);
    expect(adapted.negative_prompt).toContain("bright");
    expect(adapted.negative_prompt).toContain("cheerful");
  });

  it("should validate configuration correctly", () => {
    const validConfig = {
      prompt: "test prompt",
      additional_prompt: "test",
      negative_prompt: "test",
      guidance_scale: 7.5,
      steps: 20,
    };

    expect(adapter.validateConfig(validConfig)).toBe(true);

    const invalidConfig = {
      prompt: "",
      additional_prompt: "test",
      negative_prompt: "test",
      guidance_scale: 25, // invalid
      steps: 20,
    };

    expect(adapter.validateConfig(invalidConfig)).toBe(false);
  });
});

describe("Imagen4Adapter", () => {
  let adapter: Imagen4Adapter;

  beforeEach(() => {
    adapter = new Imagen4Adapter();
  });

  it("should have correct provider and model name", () => {
    expect(adapter.provider).toBe("google");
    expect(adapter.modelName).toBe("imagen4");
  });

  it("should adapt style configuration correctly", () => {
    const adapted = adapter.adaptStyle(mockStyleConfig);

    expect(adapted).toHaveProperty("prompt");
    expect(adapted.prompt).toContain("cinematic drama");
    expect(adapted.prompt).toContain("edge lighting");
    expect(adapted.prompt).toContain("worm's eye");

    expect(adapted.style_preset).toBe("cinematic");
    expect(adapted.guidance_scale).toBe(7.5);
    expect(adapted.aspect_ratio).toBe("16:9");
  });

  it("should infer style preset from mood", () => {
    const artisticStyle: StyleStackConfig = {
      ...mockStyleConfig,
      base: {
        ...mockStyleConfig.base,
        mood: "artistic, creative, expressive",
      },
      models: {
        // Remove imagen4 config to force inference
        "flux-pro": mockStyleConfig.models["flux-pro"],
      },
    };

    const adapted = adapter.adaptStyle(artisticStyle);
    expect(adapted.style_preset).toBe("artistic");
  });

  it("should validate configuration correctly", () => {
    const validConfig = {
      prompt: "test prompt",
      style_preset: "cinematic",
      guidance_scale: 7.5,
      aspect_ratio: "16:9" as const,
    };

    expect(adapter.validateConfig(validConfig)).toBe(true);

    const invalidConfig = {
      prompt: "test",
      style_preset: "cinematic",
      guidance_scale: 7.5,
      aspect_ratio: "21:9" as any, // invalid aspect ratio
    };

    expect(adapter.validateConfig(invalidConfig)).toBe(false);
  });
});

describe("RunwayAdapter", () => {
  let adapter: RunwayAdapter;

  beforeEach(() => {
    adapter = new RunwayAdapter();
  });

  it("should have correct provider and model name", () => {
    expect(adapter.provider).toBe("runway");
    expect(adapter.modelName).toBe("gen3");
  });

  it("should adapt style configuration for video", () => {
    const adapted = adapter.adaptStyle(mockStyleConfig);

    expect(adapted).toHaveProperty("prompt");
    expect(adapted.prompt).toContain("cinematic movement");
    expect(adapted.prompt).toContain("dynamic lighting contrast");

    expect(adapted.motion_strength).toBe(6);
    expect(adapted.camera_motion).toBe("pan_left");
    expect(adapted.duration).toBe(4);
  });

  it("should infer motion strength from mood", () => {
    const dynamicStyle: StyleStackConfig = {
      ...mockStyleConfig,
      base: {
        ...mockStyleConfig.base,
        mood: "dynamic, energetic, fast-paced",
      },
      models: {},
    };

    const adapted = adapter.adaptStyle(dynamicStyle);
    expect(adapted.motion_strength).toBe(8);
  });

  it("should infer camera motion from camera description", () => {
    const zoomStyle: StyleStackConfig = {
      ...mockStyleConfig,
      base: {
        ...mockStyleConfig.base,
        camera: "zoom in, dramatic close-ups",
      },
      models: {},
    };

    const adapted = adapter.adaptStyle(zoomStyle);
    expect(adapted.camera_motion).toBe("zoom_in");
  });

  it("should validate configuration correctly", () => {
    const validConfig = {
      prompt: "test prompt",
      motion_strength: 5,
      camera_motion: "pan_left" as const,
      duration: 3,
    };

    expect(adapter.validateConfig(validConfig)).toBe(true);

    const invalidConfig = {
      prompt: "test",
      motion_strength: 15, // invalid
      camera_motion: "pan_left" as const,
      duration: 3,
    };

    expect(adapter.validateConfig(invalidConfig)).toBe(false);
  });
});

describe("KlingAdapter", () => {
  let adapter: KlingAdapter;

  beforeEach(() => {
    adapter = new KlingAdapter();
  });

  it("should have correct provider and model name", () => {
    expect(adapter.provider).toBe("kling");
    expect(adapter.modelName).toBe("v1");
  });

  it("should adapt style configuration correctly", () => {
    const adapted = adapter.adaptStyle(mockStyleConfig);

    expect(adapted).toHaveProperty("prompt");
    expect(adapted.prompt).toContain("dark, mysterious, dramatic");
    expect(adapted.prompt).toContain("black and white with red accents");

    expect(adapted.creativity).toBe(0.8);
    expect(adapted.motion_strength).toBe(0.6);
    expect(adapted.quality).toBe("high");
  });

  it("should infer creativity level from mood", () => {
    const fantasyStyle: StyleStackConfig = {
      ...mockStyleConfig,
      base: {
        ...mockStyleConfig.base,
        mood: "fantasy, magical, surreal",
      },
      models: {},
    };

    const adapted = adapter.adaptStyle(fantasyStyle);
    expect(adapted.creativity).toBe(0.9);
  });

  it("should validate configuration correctly", () => {
    const validConfig = {
      prompt: "test prompt",
      creativity: 0.7,
      motion_strength: 0.5,
      quality: "high" as const,
    };

    expect(adapter.validateConfig(validConfig)).toBe(true);

    const invalidConfig = {
      prompt: "test",
      creativity: 1.5, // invalid
      motion_strength: 0.5,
      quality: "high" as const,
    };

    expect(adapter.validateConfig(invalidConfig)).toBe(false);
  });
});

describe("ModelAdapterRegistry", () => {
  let registry: ModelAdapterRegistry;

  beforeEach(() => {
    registry = new ModelAdapterRegistry();
  });

  it("should register all default adapters", () => {
    const availableModels = registry.getAvailableModels();

    expect(availableModels).toHaveLength(4);
    expect(availableModels).toContainEqual({
      provider: "fal",
      modelName: "flux-pro",
    });
    expect(availableModels).toContainEqual({
      provider: "google",
      modelName: "imagen4",
    });
    expect(availableModels).toContainEqual({
      provider: "runway",
      modelName: "gen3",
    });
    expect(availableModels).toContainEqual({
      provider: "kling",
      modelName: "v1",
    });
  });

  it("should get adapter by provider and model", () => {
    const adapter = registry.getAdapter("fal", "flux-pro");
    expect(adapter).toBeInstanceOf(FluxProAdapter);

    const nonExistentAdapter = registry.getAdapter("nonexistent", "model");
    expect(nonExistentAdapter).toBeNull();
  });

  it("should adapt style for specific model", () => {
    const adapted = registry.adaptStyleForModel(
      mockStyleConfig,
      "fal",
      "flux-pro",
    );

    expect(adapted).not.toBeNull();
    expect(adapted).toHaveProperty("prompt");
    expect(adapted).toHaveProperty("guidance_scale");
  });

  it("should return null for invalid model", () => {
    const adapted = registry.adaptStyleForModel(
      mockStyleConfig,
      "invalid",
      "model",
    );
    expect(adapted).toBeNull();
  });

  it("should register custom adapter", () => {
    const customAdapter = {
      provider: "custom",
      modelName: "test",
      adaptStyle: () => ({ test: "config" }),
      validateConfig: () => true,
    };

    registry.registerAdapter(customAdapter);

    const retrieved = registry.getAdapter("custom", "test");
    expect(retrieved).toBe(customAdapter);
  });
});

describe("Utility Functions", () => {
  describe("getAdaptedStyleConfig", () => {
    it("should return adapted configuration", () => {
      const adapted = getAdaptedStyleConfig(mockStyleConfig, "fal", "flux-pro");

      expect(adapted).not.toBeNull();
      expect(adapted).toHaveProperty("prompt");
    });

    it("should return null for invalid model", () => {
      const adapted = getAdaptedStyleConfig(
        mockStyleConfig,
        "invalid",
        "model",
      );
      expect(adapted).toBeNull();
    });
  });

  describe("generateAllAdaptations", () => {
    it("should generate adaptations for all models", async () => {
      const adaptations = await generateAllAdaptations(mockStyleConfig);

      expect(adaptations).toHaveLength(4);

      const fluxAdaptation = adaptations.find(
        (a) => a.provider === "fal" && a.modelName === "flux-pro",
      );
      expect(fluxAdaptation).toBeDefined();
      expect(fluxAdaptation?.config).toHaveProperty("prompt");

      const imagen4Adaptation = adaptations.find(
        (a) => a.provider === "google" && a.modelName === "imagen4",
      );
      expect(imagen4Adaptation).toBeDefined();
      expect(imagen4Adaptation?.config).toHaveProperty("style_preset");
    });

    it("should skip invalid adaptations", async () => {
      // Create a style config that might cause validation issues
      const invalidStyle: StyleStackConfig = {
        version: "1.0",
        name: "Invalid Style",
        base: {
          mood: "",
          lighting: "",
          color_palette: "",
          camera: "",
        },
        models: {},
      };

      const adaptations = await generateAllAdaptations(invalidStyle);

      // Should still generate some adaptations even if some fail
      expect(Array.isArray(adaptations)).toBe(true);
    });
  });
});

describe("Default Export", () => {
  it("should export singleton registry", () => {
    expect(modelAdapterRegistry).toBeInstanceOf(ModelAdapterRegistry);
  });
});
