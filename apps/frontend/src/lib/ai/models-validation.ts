import { z } from "zod";
import { IMAGE_MODELS } from "@/lib/ai/models";
import { letzaiImageRequestSchema } from "@/lib/schemas/letzai-request";

// Extract model keys with const assertion for type safety
export const MODEL_KEYS = Object.keys(IMAGE_MODELS) as [
  keyof typeof IMAGE_MODELS,
  ...Array<keyof typeof IMAGE_MODELS>,
];

// flux_pro_kontext_max schema
export const fluxProKontextMaxSchema = z.object({
  prompt: z.string(),
  image_url: z.string().url().optional(),
  seed: z.number().int().min(0).optional(),
  guidance_scale: z.number().positive().optional(),
  sync_mode: z.boolean().optional(),
  number_of_images: z.number().positive().optional(),
  safety_tolerance: z.enum(["1", "2", "3", "4", "5", "6"]).optional(),
  enhance_prompt: z.boolean().optional(),
  aspect_ratio: z
    .enum(["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"])
    .optional(),
  output_format: z.enum(["jpeg", "png"]).optional(),
});

export type FluxProKontextMaxSchema = z.infer<typeof fluxProKontextMaxSchema>;

// imagen4_preview_ultra schema
export const imagen4PreviewUltraSchema = z.object({
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "3:4", "4:3"]).optional(),
  num_images: z.number().positive().optional(),
  seed: z.number().int().min(0).optional(),
  resolution: z.enum(["1K", "2K"]).default("1K"),
});

export type Imagen4PreviewUltraSchema = z.infer<
  typeof imagen4PreviewUltraSchema
>;

// flux_pro_v1_1_ultra
export const fluxProV11UltraSchema = z.object({
  prompt: z.string(),
  seed: z.number().int().min(0).optional(),
  sync_mode: z.boolean().optional(),
  number_of_images: z.number().positive().optional(),
  enable_safety_checker: z.boolean().optional(),
  output_format: z.enum(["jpeg", "png"]).optional(),
  safety_tolerance: z.enum(["1", "2", "3", "4", "5", "6"]).optional(),
  aspect_ratio: z
    .enum(["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"])
    .optional(),
  raw: z.boolean().optional(),
});

export type FluxProV11UltraSchema = z.infer<typeof fluxProV11UltraSchema>;

// flux_krea_lora
export const fluxKreaLoraSchema = z.object({
  prompt: z.string(),
  image_size: z
    .union([
      z.enum([
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ]),
      z.object({
        width: z.number().positive(),
        height: z.number().positive(),
      }),
    ])
    .optional(),
  num_inference_steps: z.number().positive().optional(),
  seed: z.number().int().min(0).optional(),
  loras: z
    .array(
      z.object({
        path: z.string(),
        scale: z.number().positive().optional(),
      }),
    )
    .optional(),
  guidance_scale: z.number().positive().optional(),
  sync_mode: z.boolean().optional(),
  number_of_images: z.number().positive().optional(),
  enable_safety_checker: z.boolean().optional(),
  output_format: z.enum(["jpeg", "png"]).optional(),
});

// Basic schemas for models with minimal parameters
export const fluxProSchema = z.object({
  prompt: z.string(),
  seed: z.number().int().min(0).optional(),
  num_inference_steps: z.number().positive().optional(),
  guidance_scale: z.number().positive().optional(),
  num_images: z.number().positive().optional(),
});

export const fluxDevSchema = z.object({
  prompt: z.string(),
  seed: z.number().int().min(0).optional(),
  num_inference_steps: z.number().positive().optional(),
  guidance_scale: z.number().positive().optional(),
  num_images: z.number().positive().optional(),
});

export const fluxSchnellSchema = z.object({
  prompt: z.string(),
  seed: z.number().int().min(0).optional(),
  num_inference_steps: z.number().positive().optional(),
  guidance_scale: z.number().positive().optional(),
  num_images: z.number().positive().optional(),
});

export const sdxlSchema = z.object({
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  seed: z.number().int().min(0).optional(),
  num_inference_steps: z.number().positive().optional(),
  guidance_scale: z.number().positive().optional(),
  num_images: z.number().positive().optional(),
});

export const sdxlLightningSchema = z.object({
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  seed: z.number().int().min(0).optional(),
  num_inference_steps: z.number().positive().optional(),
  guidance_scale: z.number().positive().optional(),
  num_images: z.number().positive().optional(),
});

interface ExtraParamsSchemaByModelData {
  model: string;
  prompt: string;
  extra_params?: Record<string, unknown>;
}

// extra_params schema by model
export const extraParamsSchemaByModel = (
  data: ExtraParamsSchemaByModelData,
) => {
  // Validate extra_params based on the selected model
  const modelSchemas = {
    // Advanced models with specific schemas
    flux_pro_kontext_max: fluxProKontextMaxSchema,
    imagen4_preview_ultra: imagen4PreviewUltraSchema,
    flux_pro_v1_1_ultra: fluxProV11UltraSchema,
    flux_krea_lora: fluxKreaLoraSchema,
    letzai: letzaiImageRequestSchema,

    // Basic models with standard parameters
    flux_pro: fluxProSchema,
    flux_dev: fluxDevSchema,
    flux_schnell: fluxSchnellSchema,
    sdxl: sdxlSchema,
    sdxl_lightning: sdxlLightningSchema,
  };
  const schema = modelSchemas[data.model as keyof typeof modelSchemas];

  if (!schema) {
    throw new Error(
      `[model-validations] No validation schema found for model: ${data.model}`,
    );
  }

  const params = { prompt: data.prompt, ...data.extra_params };
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new Error(
      `[model-validations] extra_params validation failed for model ${data.model}: ${result.error.message}`,
    );
  }

  return true;
};

// Parser that returns normalized extra_params with defaults
export const parseExtraParamsByModel = (
  data: ExtraParamsSchemaByModelData,
): Record<string, unknown> => {
  const modelSchemas = {
    // Advanced models with specific schemas
    flux_pro_kontext_max: fluxProKontextMaxSchema,
    imagen4_preview_ultra: imagen4PreviewUltraSchema,
    flux_pro_v1_1_ultra: fluxProV11UltraSchema,
    flux_krea_lora: fluxKreaLoraSchema,
    letzai: letzaiImageRequestSchema,

    // Basic models with standard parameters
    flux_pro: fluxProSchema,
    flux_dev: fluxDevSchema,
    flux_schnell: fluxSchnellSchema,
    sdxl: sdxlSchema,
    sdxl_lightning: sdxlLightningSchema,
  };
  const schema = modelSchemas[data.model as keyof typeof modelSchemas];

  if (!schema) {
    throw new Error(
      `[model-validations] No validation schema found for model: ${data.model}`,
    );
  }

  const params = { prompt: data.prompt, ...data.extra_params };
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new Error(
      `[model-validations] extra_params validation failed for model ${data.model}: ${result.error.message}`,
    );
  }

  return result.data;
};

// generate image schema
export const generateImageSchema = z
  .object({
    sequence_id: z.string(),
    frame_id: z.string(),
    model: z.enum(MODEL_KEYS),
    prompt: z.string(),
    style_id: z.string().optional(),
    extra_params: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => extraParamsSchemaByModel(data), {
    message:
      "[api/v1/generates/image] Generating image | extra_params validation failed for the selected model",
  });

export type GenerateImageInput = z.infer<typeof generateImageSchema>;
