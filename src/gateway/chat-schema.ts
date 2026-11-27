/** The public text endpoint's body (#2437): text turns only; tools and media stay on the trusted in-process path. */

import { z } from 'zod';

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
});

export type GatewayChatBody = z.infer<typeof gatewayChatBodySchema>;
