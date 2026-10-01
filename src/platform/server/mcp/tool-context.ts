import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolDefinition } from '@tanstack/ai';
import type { MCPToolContext } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { OpenStoryError } from '@/platform/errors';
import { getLogger, toErrorPayload } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { McpCallerIdentity } from './auth';
import type { OAuthApiScope } from '@/platform/server/auth/oauth-scopes';

export type ReadToolContext = {
  scopedDb: ScopedDb;
  origin: string;
  userId: string;
};

/**
 * What `handle.ts` passes to `server.handle(request, { context })` for one
 * request. The db is built only when a production tool runs, after the
 * check for that tool's OAuth scope; discovery and `whoami` need none.
 */
export type OpenStoryMcpContext = {
  caller: McpCallerIdentity;
  scoped: (scope: OAuthApiScope) => ReadToolContext;
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

function toolError(text: string, code?: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(code ? { structuredContent: { error: { code, message: text } } } : {}),
  };
}

/**
 * Run one read and bound its response, including opt-in prompts, without
 * silently cutting data. Input is parsed with zod here (the SDK only checks
 * the JSON Schema, so it applies no defaults); output is parsed against the
 * advertised schema, and a mismatch is our bug, so it is logged, not returned
 * as a validation error.
 */
async function runTool<I extends z.ZodObject, O extends z.ZodObject>(
  spec: ToolSpec<I, O>,
  input: unknown,
  context: () => ReadToolContext
): Promise<CallToolResult> {
  try {
    const { data, summary } = await spec.run(
      spec.inputSchema.parse(input),
      context()
    );
    const parsed = spec.outputSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`openstory.${spec.name} output failed its schema`, {
        cause: parsed.error,
      });
    }
    const result: CallToolResult = {
      content: [
        {
          type: 'text',
          text: summary.length > 500 ? `${summary.slice(0, 500)}…` : summary,
        },
        { type: 'text', text: JSON.stringify(parsed.data) },
      ],
      structuredContent: parsed.data,
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 256 * 1024) {
      return toolError(
        'Response exceeds 256 KiB. Retry the collection with a smaller limit, disable optional prompts/assets, or use the entity/version document read with a smaller length.'
      );
    }
    return result;
  } catch (error) {
    // The SDK checks the advertised JSON Schema; refinements and the
    // discriminated unions it cannot express are checked by zod here.
    if (error instanceof z.ZodError) {
      return toolError(z.prettifyError(error), 'VALIDATION_ERROR');
    }
    if (error instanceof OpenStoryError && error.statusCode < 500) {
      return toolError(error.message, error.code);
    }
    getLogger(['openstory', 'mcp']).error('MCP tool failed', {
      tool: spec.name,
      err: toErrorPayload(error),
    });
    return toolError(
      spec.scope === 'sequences:read'
        ? 'Unable to read production data. Please retry.'
        : 'Unable to complete the request. Please retry.'
    );
  }
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
  ) => Promise<{ data: z.input<O>; summary: string }>;
};

/** One `openstory.*` tool as a `toolDefinition().server()`. */
export function openstoryTool<I extends z.ZodObject, O extends z.ZodObject>(
  spec: ToolSpec<I, O>
) {
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
