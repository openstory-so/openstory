/** The public text endpoint's body (#2437): text turns and an optional output schema; tools and media stay on the trusted in-process path. */

import { z } from 'zod';

/** The largest output schema the endpoint takes, as JSON; pipeline schemas stay under 3 KB. */
export const MAX_OUTPUT_SCHEMA_BYTES = 16_384;

/** A JSON Schema object whose root is an object, small enough to compile. */
const outputSchemaField = z
  .record(z.string(), z.unknown())
  .superRefine((schema, ctx) => {
    if (
      new TextEncoder().encode(JSON.stringify(schema)).length >
      MAX_OUTPUT_SCHEMA_BYTES
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `outputSchema is above ${MAX_OUTPUT_SCHEMA_BYTES} bytes`,
      });
      return;
    }
    if (schema.type !== 'object') {
      ctx.addIssue({
        code: 'custom',
        message: 'outputSchema must have type "object" at its root',
      });
      return;
    }
    try {
      z.fromJSONSchema(schema);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'outputSchema is not a JSON Schema',
      });
    }
  })
  .meta({
    description: `A JSON Schema the reply must match (an object at the root, at most ${MAX_OUTPUT_SCHEMA_BYTES} bytes). The stream then carries the JSON as text and ends with a \`structured-output.complete\` CUSTOM event holding the parsed object.`,
  });

export const gatewayChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1),
      })
    )
    .min(1),
  system: z.string().min(1).optional().meta({
    description: 'A system prompt.',
  }),
  maxTokens: z
    .int()
    .positive()
    .meta({
      description:
        'The most output tokens the model may write; the hold is priced on it.',
      examples: [512],
    }),
  outputSchema: outputSchemaField.optional(),
});

export type GatewayChatBody = z.infer<typeof gatewayChatBodySchema>;
