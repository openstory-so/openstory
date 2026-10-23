/**
 * The MCP tool set as `chat()` tools (#2155). Every `openstory.*` tool is
 * the same `toolDefinition().server()` the MCP server serves; this file only
 * changes how its result reaches the model and which calls wait for the
 * user. A tool added to `MCP_TOOLS` is in chat with no further work.
 *
 * - The MCP envelope (`content[]`, `structuredContent`, `isError`) is
 *   unwrapped: the model and the tool card get the structured data, an
 *   error envelope becomes a thrown error (TanStack AI reports it as the
 *   tool's error result and the run continues).
 * - A delete is `needsApproval`: the run pauses on a card the user confirms.
 *   Spending does not ask: the user is inside the app, and a generation
 *   shows up on the page as it starts, where it can be cancelled.
 * - Most tools are `lazy`: the model sees the name and first sentence, and
 *   asks for a schema when it needs one, so a turn does not carry a hundred
 *   schemas.
 * - The model sees `openstory_get_shot`, not `openstory.get_shot`: OpenAI
 *   rejects a dot in a tool name (`^[a-zA-Z0-9_-]+$`), and OpenRouter only
 *   reports that as "Provider returned error". The sets below and the
 *   approval rule keep the MCP names; only the name on the wire changes.
 */

import type { AnyTool } from '@tanstack/ai';
import { MCP_TOOLS } from '@/platform/server/mcp/server';

/** Tools the model sees in full on every turn: the ones most turns start with. */
const EAGER_TOOLS = new Set([
  'whoami',
  'openstory.list_sequences',
  'openstory.get_sequence',
  'openstory.get_sequence_status',
  'openstory.list_scenes',
  'openstory.get_scene',
  'openstory.list_shots',
  'openstory.get_shot',
  'openstory.get_shot_frames',
  'openstory.update_shot_prompt',
  'openstory.update_scene',
  'openstory.list_characters',
  'openstory.get_character',
  'openstory.list_locations',
  'openstory.get_location',
  'openstory.list_styles',
  'openstory.list_studio_uploads',
  'openstory.list_generated_assets',
  'openstory.plan_generation',
  'openstory.execute_generation',
  'openstory.get_operation_status',
  'openstory.upload_media',
  'openstory.set_shot_image_from_upload',
]);

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

function annotationsOf(tool: AnyTool): Annotations {
  const annotations: unknown = tool.metadata?.annotations;
  return typeof annotations === 'object' && annotations !== null
    ? annotations
    : {};
}

/** A write the user confirms before it runs: a delete. */
export function needsApproval(tool: AnyTool): boolean {
  const { readOnlyHint, destructiveHint } = annotationsOf(tool);
  return !readOnlyHint && destructiveHint === true;
}

type McpEnvelope = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};

function isEnvelope(value: unknown): value is McpEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray(value.content)
  );
}

/** The structured data of an MCP result, or a throw for its error envelope. */
export function unwrapMcpResult(result: unknown): unknown {
  if (!isEnvelope(result)) return result;
  const text = result.content
    ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  if (result.isError) {
    throw new Error(text || 'The tool reported an error.');
  }
  // `whoami` and any other plain tool return their object as is; an
  // `openstory.*` tool's structuredContent is its parsed output.
  return result.structuredContent ?? text;
}

/** The name the model calls a tool by: the MCP name with its dot as `_`. */
export function chatToolName(mcpName: string): string {
  return mcpName.replace(/^openstory\./, 'openstory_');
}

/** The tool list for one chat run. */
export function assistantTools(): AnyTool[] {
  return MCP_TOOLS.map((tool: AnyTool) => {
    const execute = tool.execute;
    // Every MCP tool is a `.server()`; one without a body would sit in the
    // catalog uncallable, so it fails here rather than on the user.
    if (!execute) throw new Error(`${tool.name} has no execute`);
    return {
      ...tool,
      name: chatToolName(tool.name),
      needsApproval: needsApproval(tool),
      lazy: !EAGER_TOOLS.has(tool.name),
      execute: async (input: unknown, ctx: unknown) =>
        unwrapMcpResult(await execute(input, ctx)),
    };
  });
}

/** A tool that changes nothing, by its own annotation. */
export function isReadOnlyTool(tool: AnyTool): boolean {
  return annotationsOf(tool).readOnlyHint === true;
}
