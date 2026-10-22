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
 * - A write that spends credits or deletes something is `needsApproval`, so
 *   the run pauses on a card the user confirms (the MCP client did this
 *   itself; in chat the server has to).
 * - Most tools are `lazy`: the model sees the name and first sentence, and
 *   asks for a schema when it needs one, so a turn does not carry a hundred
 *   schemas.
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

/**
 * Writes that spend credits. The catalog marks a paid write with
 * `openWorldHint: true` (`paid` / `generateAnnotations`), which
 * `needsApproval` reads; this set names the ones that spend without that
 * mark, and `assistant-tools.test.ts` pins both against the catalog.
 */
export const SPEND_TOOLS = new Set([
  'openstory.create_sequence',
  'openstory.rebuild_shot_prompts',
  'openstory.execute_generation',
  'openstory.start_export',
  'openstory.generate_shot_image',
  'openstory.generate_shot_image_variants',
  'openstory.generate_shot_video',
  'openstory.generate_character_voice',
  'openstory.generate_music',
  'openstory.regenerate_character_sheet',
  'openstory.regenerate_location_sheet',
  'openstory.regenerate_shot_dialogue',
  'openstory.regenerate_storyboard',
  'openstory.render_sequence_drafts_at_quality',
  'openstory.render_shot_at_quality',
  'openstory.render_studio_asset_at_quality',
  'openstory.create_studio_assets',
  'openstory.edit_studio_asset',
  'openstory.draft_studio_prompt',
  'openstory.rewrite_music_prompt',
  'openstory.replace_element',
  'openstory.recast_location',
  'openstory.apply_sequence_edits',
]);

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

function annotationsOf(tool: AnyTool): Annotations {
  const annotations: unknown = tool.metadata?.annotations;
  return typeof annotations === 'object' && annotations !== null
    ? annotations
    : {};
}

/** A write the user confirms before it runs: a spend or a delete. */
export function needsApproval(tool: AnyTool): boolean {
  const { readOnlyHint, destructiveHint, openWorldHint } = annotationsOf(tool);
  if (readOnlyHint) return false;
  return (
    destructiveHint === true ||
    openWorldHint === true ||
    SPEND_TOOLS.has(tool.name)
  );
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

/** The tool list for one chat run. */
export function assistantTools(): AnyTool[] {
  return MCP_TOOLS.map((tool: AnyTool) => {
    const execute = tool.execute;
    // Every MCP tool is a `.server()`; one without a body would sit in the
    // catalog uncallable, so it fails here rather than on the user.
    if (!execute) throw new Error(`${tool.name} has no execute`);
    return {
      ...tool,
      needsApproval: needsApproval(tool),
      lazy: !EAGER_TOOLS.has(tool.name),
      execute: async (input: unknown, ctx: unknown) =>
        unwrapMcpResult(await execute(input, ctx)),
    };
  });
}
