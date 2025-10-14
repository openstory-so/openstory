import { z } from "zod";

export const initializeDatabaseSchema = z.object({
  skipIfExists: z.boolean().optional().default(false),
  seedData: z.boolean().optional().default(false),
});

export const setupStatusSchema = z.object({
  includeDetails: z.boolean().optional().default(false),
});

export type InitializeDatabaseInput = z.infer<typeof initializeDatabaseSchema>;
export type SetupStatusInput = z.infer<typeof setupStatusSchema>;
