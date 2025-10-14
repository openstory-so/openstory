/**
 * ArkType validation schemas for styles (Style Stacks)
 * Replaces Zod schemas from Next.js frontend
 */

import { type } from "arktype";

/**
 * Create style request
 */
export const createStyleSchema = type({
  "name": "string",
  "configJson": "unknown", // JSON object for Style Stack configuration
  "isPublic?": "boolean",
  "metadata?": "unknown",
});

export type CreateStyleInput = typeof createStyleSchema.infer;

/**
 * Update style request
 */
export const updateStyleSchema = type({
  "name?": "string",
  "configJson?": "unknown",
  "isPublic?": "boolean",
  "metadata?": "unknown",
});

export type UpdateStyleInput = typeof updateStyleSchema.infer;

/**
 * Get styles query params
 */
export const getStylesQuerySchema = type({
  "teamId?": "string",
  "isPublic?": "boolean",
  "limit?": "number",
  "offset?": "number",
});

export type GetStylesQuery = typeof getStylesQuerySchema.infer;

/**
 * Style response
 */
export const styleResponseSchema = type({
  "id": "string",
  "teamId": "string",
  "name": "string",
  "configJson": "unknown",
  "isPublic": "boolean",
  "metadata": "unknown",
  "createdAt": "Date",
  "updatedAt": "Date",
  "createdBy": "string|null",
});

export type StyleResponse = typeof styleResponseSchema.infer;

