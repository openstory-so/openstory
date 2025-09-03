"use server";

import { z } from "zod";

export * from "./index.mock";

// Schema definitions

const createStyleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(10).max(500),
  settings: z.object({
    model: z.string().optional(),
    style_prompt: z.string().optional(),
    negative_prompt: z.string().optional(),
    aspect_ratio: z.string().optional(),
    quality: z.number().min(0).max(1).optional(),
    guidance_scale: z.number().min(1).max(20).optional(),
  }),
  is_public: z.boolean().default(false),
});

export type CreateStyleInput = z.infer<typeof createStyleSchema>;

/*
// Server actions
export async function createStyle(_input: CreateStyleInput) {
  // TODO: Implement actual database operations
  throw new Error("Not implemented - use mock in Storybook");
}

export async function updateStyle(
  _id: string,
  _input: Partial<CreateStyleInput>,
) {
  // TODO: Implement actual database operations
  throw new Error("Not implemented - use mock in Storybook");
}

export async function deleteStyle(_id: string) {
  // TODO: Implement actual database operations
  throw new Error("Not implemented - use mock in Storybook");
}

export async function getStyle(_id: string) {
  // TODO: Implement actual database operations
  throw new Error("Not implemented - use mock in Storybook");
}

export async function listStyles(_teamId?: string) {
  // TODO: Implement actual database operations
  throw new Error("Not implemented - use mock in Storybook");
}
*/
