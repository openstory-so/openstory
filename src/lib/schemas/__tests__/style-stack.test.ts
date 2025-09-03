import { describe, expect, it } from "bun:test";
import {
  ApplyStyleToFramesSchema,
  COMMON_STYLE_TAGS,
  CreateStyleSchema,
  FluxProConfigSchema,
  GetTeamStylesSchema,
  Imagen4ConfigSchema,
  KlingConfigSchema,
  ModelConfigsSchema,
  RunwayConfigSchema,
  STYLE_CATEGORIES,
  StyleStackBaseSchema,
  StyleStackConfigSchema,
  UpdateStyleSchema,
} from "../style-stack";

describe("StyleStackSchemas", () => {
  describe("StyleStackBaseSchema", () => {
    it("should validate valid base configuration", () => {
      const validBase = {
        mood: "dark, mysterious",
        lighting: "high contrast, shadows",
        color_palette: "monochrome with red accents",
        camera: "low angles, dutch tilts",
        composition: "rule of thirds",
        texture: "film grain",
        environment: "urban nighttime",
      };

      expect(() => StyleStackBaseSchema.parse(validBase)).not.toThrow();
    });

    it("should require mandatory fields", () => {
      const invalidBase = {
        mood: "dark",
        // missing required fields
      };

      expect(() => StyleStackBaseSchema.parse(invalidBase)).toThrow();
    });

    it("should allow optional fields to be omitted", () => {
      const minimalBase = {
        mood: "dark, mysterious",
        lighting: "high contrast",
        color_palette: "monochrome",
        camera: "low angles",
      };

      expect(() => StyleStackBaseSchema.parse(minimalBase)).not.toThrow();
    });
  });

  describe("FluxProConfigSchema", () => {
    it("should validate valid Flux Pro configuration", () => {
      const validConfig = {
        additional_prompt: "film noir style",
        negative_prompt: "colorful, bright",
        guidance_scale: 7.5,
        steps: 20,
      };

      expect(() => FluxProConfigSchema.parse(validConfig)).not.toThrow();
    });

    it("should enforce guidance scale limits", () => {
      const invalidConfig = {
        additional_prompt: "test",
        negative_prompt: "test",
        guidance_scale: 25, // too high
        steps: 20,
      };

      expect(() => FluxProConfigSchema.parse(invalidConfig)).toThrow();
    });

    it("should enforce steps limits", () => {
      const invalidConfig = {
        additional_prompt: "test",
        negative_prompt: "test",
        guidance_scale: 7.5,
        steps: 5, // too low
      };

      expect(() => FluxProConfigSchema.parse(invalidConfig)).toThrow();
    });

    it("should apply default values", () => {
      const minimalConfig = {
        additional_prompt: "test",
        negative_prompt: "test",
      };

      const parsed = FluxProConfigSchema.parse(minimalConfig);
      expect(parsed.guidance_scale).toBe(7.5);
      expect(parsed.steps).toBe(20);
    });
  });

  describe("Imagen4ConfigSchema", () => {
    it("should validate valid Imagen4 configuration", () => {
      const validConfig = {
        style_preset: "cinematic",
        guidance_scale: 7.5,
        aspect_ratio: "16:9" as const,
      };

      expect(() => Imagen4ConfigSchema.parse(validConfig)).not.toThrow();
    });

    it("should enforce valid aspect ratios", () => {
      const invalidConfig = {
        style_preset: "cinematic",
        aspect_ratio: "21:9", // invalid ratio
      };

      expect(() => Imagen4ConfigSchema.parse(invalidConfig)).toThrow();
    });
  });

  describe("RunwayConfigSchema", () => {
    it("should validate valid Runway configuration", () => {
      const validConfig = {
        motion_strength: 5,
        camera_motion: "pan_left" as const,
        duration: 3,
      };

      expect(() => RunwayConfigSchema.parse(validConfig)).not.toThrow();
    });

    it("should enforce motion strength limits", () => {
      const invalidConfig = {
        motion_strength: 15, // too high
      };

      expect(() => RunwayConfigSchema.parse(invalidConfig)).toThrow();
    });

    it("should enforce valid camera motions", () => {
      const invalidConfig = {
        camera_motion: "invalid_motion",
      };

      expect(() => RunwayConfigSchema.parse(invalidConfig)).toThrow();
    });
  });

  describe("KlingConfigSchema", () => {
    it("should validate valid Kling configuration", () => {
      const validConfig = {
        creativity: 0.7,
        motion_strength: 0.5,
        quality: "high" as const,
      };

      expect(() => KlingConfigSchema.parse(validConfig)).not.toThrow();
    });

    it("should enforce creativity limits", () => {
      const invalidConfig = {
        creativity: 1.5, // too high
      };

      expect(() => KlingConfigSchema.parse(invalidConfig)).toThrow();
    });

    it("should enforce valid quality values", () => {
      const invalidConfig = {
        quality: "ultra", // invalid quality
      };

      expect(() => KlingConfigSchema.parse(invalidConfig)).toThrow();
    });
  });

  describe("ModelConfigsSchema", () => {
    it("should validate mixed model configurations", () => {
      const validConfigs = {
        "flux-pro": {
          additional_prompt: "test",
          negative_prompt: "test",
        },
        imagen4: {
          style_preset: "cinematic",
        },
      };

      expect(() => ModelConfigsSchema.parse(validConfigs)).not.toThrow();
    });

    it("should allow empty configurations", () => {
      const emptyConfigs = {};
      expect(() => ModelConfigsSchema.parse(emptyConfigs)).not.toThrow();
    });
  });

  describe("StyleStackConfigSchema", () => {
    it("should validate complete style stack configuration", () => {
      const validStyleStack = {
        version: "1.0",
        name: "Test Style",
        base: {
          mood: "dark, mysterious",
          lighting: "high contrast",
          color_palette: "monochrome",
          camera: "low angles",
        },
        models: {
          "flux-pro": {
            additional_prompt: "film noir",
            negative_prompt: "colorful",
          },
        },
        characters: ["char1", "char2"],
        vfx: ["effect1"],
        audio: ["audio1"],
      };

      expect(() => StyleStackConfigSchema.parse(validStyleStack)).not.toThrow();
    });

    it("should require version and name", () => {
      const invalidStyleStack = {
        base: {
          mood: "test",
          lighting: "test",
          color_palette: "test",
          camera: "test",
        },
        models: {},
      };

      expect(() => StyleStackConfigSchema.parse(invalidStyleStack)).toThrow();
    });
  });

  describe("CreateStyleSchema", () => {
    it("should validate style creation input", () => {
      const validInput = {
        name: "Test Style",
        description: "A test style",
        config: {
          version: "1.0",
          name: "Test Style",
          base: {
            mood: "dark",
            lighting: "dramatic",
            color_palette: "monochrome",
            camera: "low angle",
          },
          models: {},
        },
        category: "cinematic",
        tags: ["test", "noir"],
        is_public: false,
      };

      expect(() => CreateStyleSchema.parse(validInput)).not.toThrow();
    });

    it("should enforce name length limits", () => {
      const invalidInput = {
        name: "", // too short
        config: {
          version: "1.0",
          name: "Test",
          base: {
            mood: "test",
            lighting: "test",
            color_palette: "test",
            camera: "test",
          },
          models: {},
        },
      };

      expect(() => CreateStyleSchema.parse(invalidInput)).toThrow();
    });

    it("should enforce tags array limits", () => {
      const invalidInput = {
        name: "Test",
        config: {
          version: "1.0",
          name: "Test",
          base: {
            mood: "test",
            lighting: "test",
            color_palette: "test",
            camera: "test",
          },
          models: {},
        },
        tags: new Array(25).fill("tag"), // too many tags
      };

      expect(() => CreateStyleSchema.parse(invalidInput)).toThrow();
    });
  });

  describe("UpdateStyleSchema", () => {
    it("should validate style update input", () => {
      const validInput = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "Updated Style",
        description: "Updated description",
      };

      expect(() => UpdateStyleSchema.parse(validInput)).not.toThrow();
    });

    it("should require valid UUID for id", () => {
      const invalidInput = {
        id: "invalid-uuid",
        name: "Updated Style",
      };

      expect(() => UpdateStyleSchema.parse(invalidInput)).toThrow();
    });

    it("should allow partial updates", () => {
      const validInput = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "Just name update",
      };

      expect(() => UpdateStyleSchema.parse(validInput)).not.toThrow();
    });
  });

  describe("ApplyStyleToFramesSchema", () => {
    it("should validate frame application input", () => {
      const validInput = {
        style_id: "123e4567-e89b-12d3-a456-426614174000",
        frame_ids: [
          "123e4567-e89b-12d3-a456-426614174001",
          "123e4567-e89b-12d3-a456-426614174002",
        ],
        options: {
          override_existing: true,
          preserve_characters: false,
        },
      };

      expect(() => ApplyStyleToFramesSchema.parse(validInput)).not.toThrow();
    });

    it("should require at least one frame ID", () => {
      const invalidInput = {
        style_id: "123e4567-e89b-12d3-a456-426614174000",
        frame_ids: [], // empty array
      };

      expect(() => ApplyStyleToFramesSchema.parse(invalidInput)).toThrow();
    });

    it("should allow missing options", () => {
      const validInput = {
        style_id: "123e4567-e89b-12d3-a456-426614174000",
        frame_ids: ["123e4567-e89b-12d3-a456-426614174001"],
      };

      expect(() => ApplyStyleToFramesSchema.parse(validInput)).not.toThrow();
    });
  });

  describe("GetTeamStylesSchema", () => {
    it("should validate team styles query", () => {
      const validInput = {
        team_id: "123e4567-e89b-12d3-a456-426614174000",
        category: "cinematic",
        tags: ["noir", "dramatic"],
        is_public: true,
        limit: 20,
        offset: 10,
        search: "test query",
      };

      expect(() => GetTeamStylesSchema.parse(validInput)).not.toThrow();
    });

    it("should apply default values", () => {
      const minimalInput = {
        team_id: "123e4567-e89b-12d3-a456-426614174000",
      };

      const parsed = GetTeamStylesSchema.parse(minimalInput);
      expect(parsed.limit).toBe(50);
      expect(parsed.offset).toBe(0);
    });

    it("should enforce limit bounds", () => {
      const invalidInput = {
        team_id: "123e4567-e89b-12d3-a456-426614174000",
        limit: 150, // too high
      };

      expect(() => GetTeamStylesSchema.parse(invalidInput)).toThrow();
    });
  });

  describe("Constants", () => {
    it("should have valid style categories", () => {
      expect(STYLE_CATEGORIES).toContain("cinematic");
      expect(STYLE_CATEGORIES).toContain("artistic");
      expect(STYLE_CATEGORIES).toContain("documentary");
      expect(STYLE_CATEGORIES.length).toBeGreaterThan(10);
    });

    it("should have valid common tags", () => {
      expect(COMMON_STYLE_TAGS).toContain("dark");
      expect(COMMON_STYLE_TAGS).toContain("bright");
      expect(COMMON_STYLE_TAGS).toContain("vintage");
      expect(COMMON_STYLE_TAGS.length).toBeGreaterThan(20);
    });
  });
});
