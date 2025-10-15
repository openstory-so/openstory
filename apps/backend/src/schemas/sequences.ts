/**
 * ArkType validation schemas for sequences
 * Replaces Zod schemas from Next.js frontend
 */

import { type } from "arktype";

/**
 * Sequence status enum (matches database enum)
 */
export const sequenceStatusSchema = type(
  "'draft'|'processing'|'completed'|'failed'|'archived'",
);

/**
 * Create sequence request
 */
export const createSequenceSchema = type({
  title: "string",
  "script?": "string",
  "styleId?": "string",
  "metadata?": "unknown",
});

export type CreateSequenceInput = typeof createSequenceSchema.infer;

/**
 * Update sequence request
 */
export const updateSequenceSchema = type({
  "title?": "string",
  "script?": "string",
  "status?": sequenceStatusSchema,
  "styleId?": "string|null",
  "metadata?": "unknown",
});

export type UpdateSequenceInput = typeof updateSequenceSchema.infer;

/**
 * Get sequences query params
 */
export const getSequencesQuerySchema = type({
  "teamId?": "string",
  "status?": sequenceStatusSchema,
  "limit?": "number",
  "offset?": "number",
});

export type GetSequencesQuery = typeof getSequencesQuerySchema.infer;

/**
 * Sequence response
 */
export const sequenceResponseSchema = type({
  id: "string",
  teamId: "string",
  title: "string",
  script: "string|null",
  status: sequenceStatusSchema,
  styleId: "string|null",
  metadata: "unknown",
  createdAt: "Date",
  updatedAt: "Date",
  createdBy: "string|null",
  updatedBy: "string|null",
});

export type SequenceResponse = typeof sequenceResponseSchema.infer;
