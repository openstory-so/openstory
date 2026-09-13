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

/**
 * Levers no endpoint's Input Schema carries, supplied by the estimator
 * beside the request body. Every other `input.param` an extracted card
 * binds must be a real schema param — the model's own examples cannot
 * verify a lever it invented (#1605).
 */
export const CARD_LEVEL_PARAMS: readonly string[] = [
  /** Kling: driven from the prompt, priced as a tier. */
  'voice_control',
  /** H3 Max r2v: reference tokens scale with pixels the URL does not carry. */
  'reference_image_pixels',
];

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
    // strict: a sibling core op next to `lookup` would otherwise be stripped
    // silently, storing a different price than written.
    z.strictObject({
      lookup: z.strictObject({
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
  z
    .object({
      ...inputBase,
      kind: z.literal('enum'),
      values: z.array(z.string()).min(1),
      default: z.string().optional(),
    })
    .refine(
      (i) => i.default === undefined || i.values.includes(i.default),
      'default must be one of values'
    ),
  z.object({
    ...inputBase,
    kind: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  /** Length of a list param (`image_urls`), 0 when absent. */
  z.object({ ...inputBase, kind: z.literal('count') }),
  /** `{width, height}` or a preset name; binds `<name>.width` / `<name>.height`. */
  z
    .object({
      ...inputBase,
      kind: z.literal('dimensions'),
      presets: z
        .record(z.string(), z.tuple([z.number(), z.number()]))
        .optional(),
      default: z.string().optional(),
    })
    .refine(
      (i) => i.default === undefined || i.presets?.[i.default] !== undefined,
      'default must be a preset name'
    ),
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
    // Real ISO dates: an LLM-emitted "soon" would never compare past `now`,
    // so a promo card would never be re-extracted.
    extractedAt: z.iso.datetime(),
    /** When the text names a promo end — re-extract after this. */
    expiresAt: z.iso.datetime().optional(),
  }),
});

export type RateCard = z.infer<typeof rateCardSchema>;
