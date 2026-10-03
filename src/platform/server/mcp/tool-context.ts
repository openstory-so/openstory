import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolDefinition } from '@tanstack/ai';
import type { MCPToolContext } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { OpenStoryError } from '@/platform/errors';
import { getLogger, toErrorPayload } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { LikenessRequestContext } from '@/cast/server/upload-rights';
import type { McpCallerIdentity } from './auth';
import type { OAuthApiScope } from '@/platform/server/auth/oauth-scopes';

export type ReadToolContext = {
  scopedDb: ScopedDb;
  origin: string;
  userId: string;
  /** Recorded on any portrait sign-off a write carries. */
  request: LikenessRequestContext;
};

/**
 * What `handle.ts` passes to `server.handle(request, { context })` for one
 * request. The db is built only when a production tool runs, after the
 * check for that tool's OAuth scope; discovery and `whoami` need none.
 */
export type OpenStoryMcpContext = {
  caller: McpCallerIdentity;
  /** The host the request reached; media URLs and view CSP use it. */
  origin: string;
  scoped: (scope: OAuthApiScope) => ReadToolContext;
};
export type OpenStoryToolContext = MCPToolContext<OpenStoryMcpContext>;

/** One tool result or resource read (structured data and text together) over 256 KiB. */
export const overResponseCap = (text: string) =>
  new TextEncoder().encode(text).length > 256 * 1024;

export const sequenceInput = z.strictObject({
  sequenceId: ulidSchema,
});
export const pageInput = sequenceInput.extend({
  limit: z.int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional(),
  includePrompts: z.boolean().default(false),
  includeAssets: z.boolean().default(false),
});
export const collectionInput = sequenceInput.extend({
  limit: z.int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional(),
});
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function toolError(
  text: string,
  code?: string,
  details?: Record<string, unknown>
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(code
      ? {
          structuredContent: {
            error: { code, message: text, ...(details ? { details } : {}) },
          },
        }
      : {}),
  };
}

const logger = getLogger(['openstory', 'mcp']);

/** The schema under `.optional()` / `.nullable()` / `.default()`. */
function unwrapped(field: z.ZodType): z.ZodType {
  if (
    !(
      field instanceof z.ZodOptional ||
      field instanceof z.ZodNullable ||
      field instanceof z.ZodDefault
    )
  ) {
    return field;
  }
  // `unwrap()` is typed as the core schema on one of the three; the runtime
  // value is always a ZodType.
  const inner: unknown = field.unwrap();
  return inner instanceof z.ZodType ? unwrapped(inner) : field;
}

/**
 * Some clients (Claude's connector among them) send every scalar argument as a
 * string. A string the schema rejects is retried as the boolean or number it
 * spells, and kept only if the schema then accepts it, so unions
 * (`number | 'auto'`) and literals (`confirm: true`) work as well as plain
 * numbers and booleans; an object field (`replaceWritten: { visual: 'true' }`)
 * is coerced the same way. A string the schema already accepts, such as
 * `'auto'`, is left alone; anything else is left for zod to reject.
 */
export function coerceScalars(schema: z.ZodObject, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const out: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(out)) {
    const field = schema.shape[key];
    if (!field) continue;
    const inner = unwrapped(field);
    if (
      inner instanceof z.ZodObject &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      out[key] = coerceScalars(inner, value);
      continue;
    }
    if (typeof value !== 'string' || field.safeParse(value).success) continue;
    const text = value.trim();
    const candidates = [
      text === 'true' ? true : text === 'false' ? false : undefined,
      text !== '' && Number.isFinite(Number(text)) ? Number(text) : undefined,
    ];
    const spelled = candidates.find(
      (candidate) =>
        candidate !== undefined && field.safeParse(candidate).success
    );
    if (spelled !== undefined) out[key] = spelled;
  }
  return out;
}

/** The ids a result carries at its top level (`id`, `*Id`, `*Ids`). */
function topLevelIds(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) return {};
  return Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) =>
        /^id$|Ids?$/.test(key) &&
        (typeof value === 'string' || Array.isArray(value))
    )
  );
}

/**
 * A write that ran but whose result cannot be returned as a success: the SDK
 * validates a success envelope's `structuredContent` against the output
 * schema, so the only envelope that carries anything else is an error one.
 * Its text says the work is done and never asks for a retry (a retry of a
 * `generate` tool would spend twice); `details.ids` are the top-level ids and
 * `json`, when it fits, the whole result as text.
 */
function unreportedWrite(
  name: string,
  data: unknown,
  reason: string,
  json?: string
): CallToolResult {
  const result = toolError(
    `openstory.${name} completed, but its result could not be returned: ${reason}. Do not call it again; read the entity back with the matching read tool.`,
    'RESULT_NOT_RETURNED',
    { ids: topLevelIds(data) }
  );
  if (json !== undefined) result.content.push({ type: 'text', text: json });
  return result;
}

/**
 * Run one tool and bound its response, including opt-in prompts, without
 * silently cutting data. Input is parsed with zod here (the SDK only checks
 * the JSON Schema, so it applies no defaults); output is parsed against the
 * advertised schema, and a mismatch is our bug, so it is logged, not returned
 * as a validation error. A write that ran is never answered with a retry.
 */
async function runTool<I extends z.ZodObject, O extends z.ZodObject>(
  spec: ToolSpec<I, O>,
  input: unknown,
  context: () => ReadToolContext
): Promise<CallToolResult> {
  // The SDK checks the advertised JSON Schema; refinements, defaults and the
  // discriminated unions it cannot express are checked by zod here. Some
  // tools parse the caller's input again inside `run` (Studio's mapped
  // request, a library kind's parent), so a ZodError from there is the
  // caller's too (the catch below).
  const parsed = spec.inputSchema.safeParse(
    coerceScalars(spec.inputSchema, input)
  );
  if (!parsed.success) {
    return toolError(z.prettifyError(parsed.error), 'VALIDATION_ERROR');
  }
  const written = !spec.annotations.readOnlyHint;
  try {
    const { data, summary, images } = await spec.run(parsed.data, context());
    const output = spec.outputSchema.safeParse(data);
    if (!output.success && !written) {
      throw new Error(`openstory.${spec.name} output failed its schema`, {
        cause: output.error,
      });
    }
    if (!output.success) {
      logger.error('MCP tool output failed its schema', {
        tool: spec.name,
        err: toErrorPayload(output.error),
      });
    }
    // Through JSON so an `undefined` optional field is dropped: the SDK's
    // output validator rejects the key, and the call failed after it ran.
    const json = JSON.stringify(output.success ? output.data : data);
    const result: CallToolResult = output.success
      ? {
          content: [
            {
              type: 'text',
              text:
                summary.length > 500 ? `${summary.slice(0, 500)}…` : summary,
            },
            { type: 'text', text: json },
          ],
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the parsed output, round-tripped through JSON
          structuredContent: JSON.parse(json) as Record<string, unknown>,
        }
      : unreportedWrite(spec.name, data, 'its shape was unexpected', json);
    // Image bytes stay out of structuredContent. The 256 KiB cap still counts them.
    if (output.success && images?.length) {
      for (const image of images) {
        result.content.push({
          type: 'image',
          data: image.data,
          mimeType: image.mimeType,
        });
      }
    }
    if (overResponseCap(JSON.stringify(result))) {
      return written
        ? unreportedWrite(spec.name, data, 'it exceeds 256 KiB')
        : toolError(
            'Response exceeds 256 KiB. Retry the collection with a smaller limit, disable optional prompts/assets, or use the entity/version document read with a smaller length.'
          );
    }
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return toolError(z.prettifyError(error), 'VALIDATION_ERROR');
    }
    if (error instanceof OpenStoryError && error.statusCode < 500) {
      return toolError(error.message, error.code, error.details);
    }
    logger.error('MCP tool failed', {
      tool: spec.name,
      err: toErrorPayload(error),
    });
    return toolError('Unable to complete the request. Please retry.');
  }
}

const registeredWrites = new Map<
  string,
  (input: unknown, ctx: ReadToolContext) => Promise<CallToolResult>
>();

/**
 * Run a registered `sequences:write` tool by its unprefixed name. Generation
 * tools are omitted: one approval must not spend credits. Returns null when
 * the name is not an edit.
 */
export function runRegisteredWrite(
  name: string
): ((input: unknown, ctx: ReadToolContext) => Promise<CallToolResult>) | null {
  return registeredWrites.get(name) ?? null;
}

type ToolSpec<I extends z.ZodObject, O extends z.ZodObject> = {
  name: string;
  /** The OAuth scope the tool needs (`osk_` keys are unscoped). */
  scope: OAuthApiScope;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  description: string;
  inputSchema: I;
  outputSchema: O;
  run: (
    input: z.output<I>,
    ctx: ReadToolContext
  ) => Promise<{
    data: z.input<O>;
    summary: string;
    /** Base64 JPEGs appended as MCP image content, in structured-data order. */
    images?: { data: string; mimeType: 'image/jpeg' }[];
  }>;
};

/** One `openstory.*` tool as a `toolDefinition().server()`. */
export function openstoryTool<I extends z.ZodObject, O extends z.ZodObject>(
  spec: ToolSpec<I, O>
) {
  if (
    spec.scope === 'sequences:write' &&
    spec.name !== 'apply_sequence_edits'
  ) {
    registeredWrites.set(spec.name, (input, ctx) =>
      runTool(spec, input, () => ctx)
    );
  }
  return toolDefinition({
    name: `openstory.${spec.name}` as const,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    metadata: { annotations: spec.annotations },
  }).server<OpenStoryToolContext>(
    // createMCPServer sends a CallToolResult as is, which keeps the error
    // envelope and the JSON text fallback; the typed output is its
    // structuredContent.
    async (input, ctx) => {
      const result = await runTool(spec, input, () =>
        ctx.context.scoped(spec.scope)
      );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the result is a CallToolResult, passed through as is (see above)
      return result as never;
    }
  );
}

/** A read-only tool needing `sequences:read`. */
export function readToolDefinition<
  I extends z.ZodObject,
  O extends z.ZodObject,
>(spec: Omit<ToolSpec<I, O>, 'scope' | 'annotations'>) {
  return openstoryTool({
    ...spec,
    scope: 'sequences:read',
    annotations: readOnlyAnnotations,
  });
}

/** A read whose model-visible summary is the first sentence of its description. */
export function productionRead<I extends z.ZodObject, O extends z.ZodObject>(
  name: string,
  description: string,
  inputSchema: I,
  outputSchema: O,
  action: (input: z.output<I>, ctx: ReadToolContext) => Promise<z.input<O>>
) {
  return readToolDefinition({
    name,
    description,
    inputSchema,
    outputSchema,
    run: async (input, ctx) => ({
      data: await action(input, ctx),
      summary: description.split('.')[0] ?? name,
    }),
  });
}
