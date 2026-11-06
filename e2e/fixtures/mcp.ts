/** MCP calls over the signed-in session, shared by the MCP specs (#2243). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext } from 'playwright/test';
import { z } from 'zod';
import { expect } from './base';

export const ToolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string().optional() })).optional(),
  structuredContent: z.unknown().optional(),
});
export const RpcReply = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

let rpcId = 0;

export async function rpc(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown> = {}
): Promise<z.infer<typeof RpcReply>> {
  const res = await request.post('/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return RpcReply.parse(JSON.parse(line ? line.slice(6) : text));
}

export async function callTool(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>
): Promise<z.infer<typeof ToolResult> & { error?: string }> {
  const { result, error } = await rpc(request, 'tools/call', {
    name: `openstory.${name}`,
    arguments: args,
  });
  if (error) return { isError: true, error: error.message };
  return ToolResult.parse(result);
}

export const text = (tool: z.infer<typeof ToolResult> & { error?: string }) =>
  tool.error ?? tool.content?.map((c) => c.text).join(' ') ?? '';

/** Call a tool; a tool error fails the test. Parses the result with `schema`. */
export async function call(
  request: APIRequestContext,
  name: string,
  args?: Record<string, unknown>
): Promise<unknown>;
export async function call<S extends z.ZodType>(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
  schema: S
): Promise<z.infer<S>>;
export async function call(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {},
  schema?: z.ZodType
): Promise<unknown> {
  const tool = await callTool(request, name, args);
  expect(tool.isError ?? false, `${name}: ${text(tool)}`).toBe(false);
  return schema ? schema.parse(tool.structuredContent) : tool.structuredContent;
}

/** Call a tool that must refuse; returns the refusal text. */
export async function refuse(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = await callTool(request, name, args);
  expect(tool.isError, `${name} should refuse`).toBe(true);
  return text(tool);
}

export const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../fixtures', name)).toString(
    'base64'
  );

/** upload_media a fixture file; returns the upload handle. */
export async function upload(
  request: APIRequestContext,
  sequenceId: string,
  use: string,
  filename: string,
  mimeType: string,
  attest = false
): Promise<string> {
  const out = await call(
    request,
    'upload_media',
    {
      sequenceId,
      use,
      data: fixture(filename),
      mimeType,
      filename,
      ...(attest && {
        portraitAttestation: {
          statementVersion: 'portrait-rights-v1',
          authorizationBasis: 'self',
        },
      }),
    },
    z.object({ upload: z.string(), rights: z.unknown() })
  );
  return out.upload;
}
