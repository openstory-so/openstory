/**
 * Rate card (#1605) — a provider's advertised price as data, evaluated
 * deterministically against the request we are about to send.
 *
 * A card is JSONLogic (a published spec LLMs already know; pure data, no code
 * execution, Workers-safe) over a closed vocabulary: the core ops below plus
 * `lookup` (named tables) and `ceil` / `floor`. Each lever is bound to the
 * endpoint's real request parameter name so the estimator can hand the card
 * the built request body. `examples` are the page's own worked examples;
 * `verifyRateCardExamples` must reproduce every one or the card is rejected.
 *
 * Pre-flight estimate only. Billing stays `unitsBilled × verified unitPrice`.
 */
import { z } from 'zod';

export const CORE_OPS = [
  'var',
  'missing',
  '+',
  '-',
  '*',
  '/',
  'max',
  'min',
  'if',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  'ceil',
  'floor',
] as const;

export type CoreOp = (typeof CORE_OPS)[number];

export type Expr =
  | number
  | string
  | boolean
  | { lookup: { table: string; keys: Expr[]; default?: Expr } }
  | { [op in CoreOp]?: Expr | Expr[] };

const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.object({
      lookup: z.object({
        table: z.string(),
        keys: z.array(exprSchema).min(1),
        default: exprSchema.optional(),
      }),
    }),
    z
      .partialRecord(
        z.enum(CORE_OPS),
        z.union([exprSchema, z.array(exprSchema)])
      )
      .refine((ops) => Object.keys(ops).length === 1, 'one op per node'),
  ])
);

/** Nested numeric lookup: `tables.rate['720p'].video` → number. */
export type Table = { [key: string]: number | Table };

const tableSchema: z.ZodType<Table> = z.lazy(() =>
  z.record(z.string(), z.union([z.number(), tableSchema]))
);

const inputBase = {
  /** The request body field this lever reads. */
  param: z.string().min(1),
};

const inputSchema = z.discriminatedUnion('kind', [
  z.object({
    ...inputBase,
    kind: z.literal('number'),
    default: z.number().optional(),
  }),
  z.object({
    ...inputBase,
    kind: z.literal('enum'),
    values: z.array(z.string()).min(1),
    default: z.string().optional(),
  }),
  z.object({
    ...inputBase,
    kind: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  /** Length of a list param (`image_urls`), 0 when absent. */
  z.object({ ...inputBase, kind: z.literal('count') }),
  /** `{width, height}` or a preset name; binds `<name>.width` / `<name>.height`. */
  z.object({
    ...inputBase,
    kind: z.literal('dimensions'),
    presets: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
    default: z.string().optional(),
  }),
]);

const rateCardExampleSchema = z.object({
  /** Request params, exactly as the endpoint would receive them. */
  params: z.record(z.string(), z.unknown()),
  usd: z.number().positive(),
  /** The sentence in the source text this example comes from. */
  quote: z.string().min(1),
});

export type RateCardExample = z.infer<typeof rateCardExampleSchema>;

export const rateCardSchema = z.object({
  inputs: z.record(z.string(), inputSchema),
  tables: z.record(z.string(), tableSchema),
  /** JSONLogic yielding USD for one request. */
  price: exprSchema,
  examples: z.array(rateCardExampleSchema),
  source: z.object({
    url: z.string().url(),
    /** sha256 of the source text the card was read from. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    extractedAt: z.string().meta({ format: 'date-time' }),
    /** When the text names a promo end — re-extract after this. */
    expiresAt: z.string().meta({ format: 'date-time' }).optional(),
  }),
});

export type RateCard = z.infer<typeof rateCardSchema>;
