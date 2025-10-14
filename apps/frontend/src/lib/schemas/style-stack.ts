import { z } from "zod";

// Base Style Stack configuration schema
export const StyleStackBaseSchema = z.object({
  mood: z.string().describe("Overall mood/atmosphere of the style"),
  lighting: z.string().describe("Lighting characteristics and setup"),
  color_palette: z.string().describe("Color scheme and palette description"),
  camera: z.string().describe("Camera angles, movements, and framing"),
  composition: z
    .string()
    .optional()
    .describe("Composition rules and guidelines"),
  texture: z.string().optional().describe("Surface textures and materials"),
  environment: z.string().optional().describe("Environmental characteristics"),
});

// Model-specific configuration schemas
export const FluxProConfigSchema = z.object({
  additional_prompt: z.string().describe("Additional prompt text for Flux Pro"),
  negative_prompt: z
    .string()
    .describe("Negative prompt to avoid unwanted elements"),
  guidance_scale: z
    .number()
    .min(1)
    .max(20)
    .default(7.5)
    .describe("Guidance scale for generation"),
  steps: z
    .number()
    .min(10)
    .max(50)
    .default(20)
    .describe("Number of diffusion steps"),
});

export const Imagen4ConfigSchema = z.object({
  style_preset: z.string().describe("Predefined style preset for Imagen4"),
  guidance_scale: z
    .number()
    .min(1)
    .max(20)
    .default(7.5)
    .describe("Guidance scale for generation"),
  aspect_ratio: z
    .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
    .default("16:9")
    .describe("Aspect ratio"),
});

export const RunwayConfigSchema = z.object({
  motion_strength: z
    .number()
    .min(0)
    .max(10)
    .default(5)
    .describe("Strength of motion in video generation"),
  camera_motion: z
    .enum(["static", "pan_left", "pan_right", "zoom_in", "zoom_out"])
    .default("static")
    .describe("Camera movement type"),
  duration: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe("Video duration in seconds"),
});

export const KlingConfigSchema = z.object({
  creativity: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Creativity level for generation"),
  motion_strength: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Motion strength"),
  quality: z
    .enum(["standard", "high"])
    .default("high")
    .describe("Generation quality"),
});

// Model configurations union
export const ModelConfigsSchema = z
  .object({
    "flux-pro": FluxProConfigSchema.optional(),
    imagen4: Imagen4ConfigSchema.optional(),
    runway: RunwayConfigSchema.optional(),
    kling: KlingConfigSchema.optional(),
  })
  .partial();

// Complete Style Stack configuration
export const StyleStackConfigSchema = z.object({
  version: z.string().describe("Style Stack schema version"),
  name: z.string().describe("Style name"),
  base: StyleStackBaseSchema.describe("Base style configuration"),
  models: ModelConfigsSchema.describe("Model-specific configurations"),
  characters: z
    .array(z.string())
    .optional()
    .describe("Character references from team library"),
  vfx: z
    .array(z.string())
    .optional()
    .describe("VFX preset references from team library"),
  audio: z
    .array(z.string())
    .optional()
    .describe("Audio references from team library"),
});

// Style creation and update schemas
export const CreateStyleSchema = z.object({
  name: z.string().min(1).max(255).describe("Style name"),
  description: z.string().max(2000).optional().describe("Style description"),
  config: StyleStackConfigSchema.describe("Style Stack configuration"),
  category: z.string().max(100).optional().describe("Style category"),
  tags: z
    .array(z.string())
    .max(20)
    .default([])
    .describe("Tags for categorization"),
  is_public: z.boolean().default(false).describe("Whether style is public"),
  preview_url: z.string().url().optional().describe("Preview image URL"),
});

export const UpdateStyleSchema = CreateStyleSchema.partial().extend({
  id: z.string().uuid().describe("Style ID to update"),
});

export const DuplicateStyleSchema = z.object({
  id: z.string().uuid().describe("Original style ID"),
  name: z.string().min(1).max(255).describe("New style name"),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe("New style description"),
});

// Style application schema
export const ApplyStyleToFramesSchema = z.object({
  style_id: z.string().uuid().describe("Style ID to apply"),
  frame_ids: z
    .array(z.string().uuid())
    .min(1)
    .describe("Frame IDs to apply style to"),
  options: z
    .object({
      override_existing: z
        .boolean()
        .default(false)
        .describe("Override existing style configurations"),
      preserve_characters: z
        .boolean()
        .default(true)
        .describe("Keep existing character assignments"),
    })
    .optional(),
});

// Import/Export schemas
export const ImportStyleSchema = z.object({
  style_data: StyleStackConfigSchema.describe("Style configuration to import"),
  name: z.string().min(1).max(255).optional().describe("Override style name"),
  category: z.string().max(100).optional().describe("Style category"),
  tags: z
    .array(z.string())
    .max(20)
    .default([])
    .describe("Tags for categorization"),
});

export const ExportStyleSchema = z.object({
  id: z.string().uuid().describe("Style ID to export"),
  include_adaptations: z
    .boolean()
    .default(false)
    .describe("Include model-specific adaptations"),
});

// Style adaptation schemas
export const CreateStyleAdaptationSchema = z.object({
  style_id: z.string().uuid().describe("Style ID"),
  model_provider: z
    .string()
    .min(1)
    .max(100)
    .describe("Model provider (e.g., 'fal', 'runway')"),
  model_name: z
    .string()
    .min(1)
    .max(100)
    .describe("Model name (e.g., 'flux-pro', 'imagen4')"),
  adapted_config: z
    .record(z.string(), z.unknown())
    .describe("Model-specific configuration"),
});

// Query schemas
export const GetTeamStylesSchema = z.object({
  team_id: z.string().uuid().describe("Team ID"),
  category: z.string().optional().describe("Filter by category"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  is_public: z.boolean().optional().describe("Filter by public/private"),
  is_template: z.boolean().optional().describe("Filter by template status"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .describe("Number of results to return"),
  offset: z.number().min(0).default(0).describe("Number of results to skip"),
  search: z.string().optional().describe("Search term for name/description"),
});

export const GetStyleByIdSchema = z.object({
  id: z.string().uuid().describe("Style ID"),
  include_adaptations: z
    .boolean()
    .default(false)
    .optional()
    .describe("Include model adaptations"),
});

// Type exports
export type StyleStackConfig = z.infer<typeof StyleStackConfigSchema>;
export type StyleStackBase = z.infer<typeof StyleStackBaseSchema>;
export type ModelConfigs = z.infer<typeof ModelConfigsSchema>;
export type FluxProConfig = z.infer<typeof FluxProConfigSchema>;
export type Imagen4Config = z.infer<typeof Imagen4ConfigSchema>;
export type RunwayConfig = z.infer<typeof RunwayConfigSchema>;
export type KlingConfig = z.infer<typeof KlingConfigSchema>;

export type CreateStyleInput = z.infer<typeof CreateStyleSchema>;
export type UpdateStyleInput = z.infer<typeof UpdateStyleSchema>;
export type DuplicateStyleInput = z.infer<typeof DuplicateStyleSchema>;
export type ApplyStyleToFramesInput = z.infer<typeof ApplyStyleToFramesSchema>;
export type ImportStyleInput = z.infer<typeof ImportStyleSchema>;
export type ExportStyleInput = z.infer<typeof ExportStyleSchema>;
export type CreateStyleAdaptationInput = z.infer<
  typeof CreateStyleAdaptationSchema
>;
export type GetTeamStylesInput = z.infer<typeof GetTeamStylesSchema>;
export type GetStyleByIdInput = z.infer<typeof GetStyleByIdSchema>;

// Predefined categories for consistency
export const STYLE_CATEGORIES = [
  "cinematic",
  "artistic",
  "documentary",
  "animation",
  "commercial",
  "music_video",
  "vintage",
  "futuristic",
  "noir",
  "vibrant",
  "minimal",
  "fantasy",
  "sci-fi",
  "horror",
  "comedy",
] as const;

export type StyleCategory = (typeof STYLE_CATEGORIES)[number];

// Common tags for styles
export const COMMON_STYLE_TAGS = [
  // Mood
  "dark",
  "bright",
  "mysterious",
  "cheerful",
  "dramatic",
  "calm",
  "intense",
  // Visual style
  "high-contrast",
  "soft",
  "sharp",
  "vintage",
  "modern",
  "retro",
  "futuristic",
  // Color
  "monochrome",
  "colorful",
  "desaturated",
  "vibrant",
  "warm",
  "cool",
  "neon",
  // Camera
  "wide-angle",
  "close-up",
  "aerial",
  "low-angle",
  "dutch-tilt",
  // Lighting
  "natural",
  "studio",
  "golden-hour",
  "blue-hour",
  "neon-lit",
  "candlelight",
  // Genre
  "action",
  "romance",
  "thriller",
  "comedy",
  "horror",
  "fantasy",
  "sci-fi",
] as const;

export type StyleTag = (typeof COMMON_STYLE_TAGS)[number];
