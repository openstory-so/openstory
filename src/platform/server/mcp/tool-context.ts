import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolDefinition } from '@tanstack/ai';
import type { MCPToolContext } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { OpenStoryError } from '@/platform/errors';
import { getLogger, toErrorPayload } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { McpCallerIdentity } from './auth';

export type ReadToolContext = { scopedDb: ScopedDb; origin: string };
type ReadToolContextFactory = () => ReadToolContext;

/**
 * What `handle.ts` passes to `server.handle(request, { context })` for one
 * request. The db is built only when a production tool runs, after its scope
 * check; discovery and `whoami` need none.
 */
export type OpenStoryMcpContext = {
  caller: McpCallerIdentity;
  readContext: ReadToolContextFactory;
};
export type OpenStoryToolContext = MCPToolContext<OpenStoryMcpContext>;

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

/** Bound tool responses, including opt-in prompts, without silently cutting data. */
async function readTool(
  context: ReadToolContextFactory,
  action: (
    ctx: ReadToolContext
  ) => Promise<{ data: Record<string, unknown>; summary: string }>
): Promise<CallToolResult> {
  try {
    const { data, summary } = await action(context());
    const result: CallToolResult = {
      content: [
        {
          type: 'text',
          text: summary.length > 500 ? `${summary.slice(0, 500)}…` : summary,
        },
        { type: 'text', text: JSON.stringify(data) },
      ],
      structuredContent: data,
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 256 * 1024) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Response exceeds 256 KiB. Retry the collection with a smaller limit, disable optional prompts/assets, or use the entity/version document read with a smaller length.',
          },
        ],
      };
    }
    return result;
  } catch (error) {
    // The SDK checks the advertised JSON Schema; refinements and the
    // discriminated unions it cannot express are checked by zod here.
    if (error instanceof z.ZodError) {
      const message = z.prettifyError(error);
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
        structuredContent: { error: { code: 'VALIDATION_ERROR', message } },
      };
    }
    if (error instanceof OpenStoryError && error.statusCode < 500) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
        structuredContent: {
          error: { code: error.code, message: error.message },
        },
      };
    }
    getLogger(['openstory', 'mcp']).error('MCP read tool failed', {
      err: toErrorPayload(error),
    });
    return {
      isError: true,
      content: [
        { type: 'text', text: 'Unable to read production data. Please retry.' },
      ],
    };
  }
}

/**
 * One read-only `openstory.*` tool as a `toolDefinition().server()`.
 * Input is parsed with zod here (the SDK only checks the JSON Schema, so it
 * applies no defaults), and output is parsed against the advertised schema.
 */
export function readToolDefinition<
  I extends z.ZodObject,
  O extends z.ZodObject,
>(spec: {
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  run: (
    input: z.output<I>,
    ctx: ReadToolContext
  ) => Promise<{ data: z.input<O>; summary: string }>;
}) {
  return toolDefinition({
    name: `openstory.${spec.name}` as const,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    metadata: { annotations: readOnlyAnnotations },
  }).server<OpenStoryToolContext>(
    // createMCPServer sends a CallToolResult as is, which keeps the error
    // envelope and the JSON text fallback; the typed output is its
    // structuredContent.
    async (input, ctx) => {
      const result = await readTool(
        ctx.context.readContext,
        async (readCtx) => {
          const { data, summary } = await spec.run(
            spec.inputSchema.parse(input),
            readCtx
          );
          return { data: spec.outputSchema.parse(data), summary };
        }
      );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the result is a CallToolResult, passed through as is (see above)
      return result as never;
    }
  );
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
