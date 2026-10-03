/**
 * One write for every non-generating sequence edit (#2009 follow-up).
 * Hosts ask permission per tool name; this runs the individual edit tools
 * in order so a scene, shot, prompt, cast and music change is one approval.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { openstoryTool, runRegisteredWrite } from '../tool-context';

const changeSchema = z.strictObject({
  tool: z
    .string()
    .describe(
      'Edit tool name without the openstory. prefix, such as update_scene or update_shot_prompt.'
    ),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('That tool’s arguments. sequenceId is filled in for you.'),
});

function textOf(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === 'text');
  return block && 'text' in block ? block.text : 'Edit failed.';
}

export const applySequenceEdits = openstoryTool({
  name: 'apply_sequence_edits',
  description:
    'Apply one or more sequence edits in a single call (one permission). Each change is { tool, arguments } for a sequences:write tool: update_sequence, update_scene, create/reorder/delete/restore scene and shot, update_shot, shot prompts, spec, dialogue and version selection, characters, locations, elements and music. sequenceId is taken from this call. Stops at the first failure; earlier changes are already saved, so do not retry those. Does not generate or spend credits — use the generate_* tools for that.',
  scope: 'sequences:write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.strictObject({
    sequenceId: ulidSchema,
    changes: z.array(changeSchema).min(1).max(20),
  }),
  outputSchema: z.object({
    sequenceId: z.string(),
    applied: z.array(
      z.object({
        tool: z.string(),
        summary: z.string(),
        data: z.record(z.string(), z.unknown()),
      })
    ),
    stoppedAt: z
      .object({
        index: z.number().int(),
        tool: z.string(),
        message: z.string(),
      })
      .nullable(),
  }),
  run: async (input, ctx) => {
    const applied: {
      tool: string;
      summary: string;
      data: Record<string, unknown>;
    }[] = [];
    let stoppedAt: {
      index: number;
      tool: string;
      message: string;
    } | null = null;

    for (const [index, change] of input.changes.entries()) {
      const run = runRegisteredWrite(change.tool);
      if (!run) {
        stoppedAt = {
          index,
          tool: change.tool,
          message: `Unknown edit "${change.tool}". Use a sequences:write tool name. Generation stays on its own tools.`,
        };
        break;
      }
      const args = change.arguments ?? {};
      if (
        typeof args.sequenceId === 'string' &&
        args.sequenceId !== input.sequenceId
      ) {
        stoppedAt = {
          index,
          tool: change.tool,
          message: 'arguments.sequenceId does not match this call.',
        };
        break;
      }
      const result = await run({ ...args, sequenceId: input.sequenceId }, ctx);
      if (!result || result.isError) {
        stoppedAt = {
          index,
          tool: change.tool,
          message: result ? textOf(result) : 'Edit failed.',
        };
        break;
      }
      const raw = result.structuredContent;
      const data: Record<string, unknown> =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
      const summary = textOf(result);
      applied.push({ tool: change.tool, summary, data });
    }

    const summary = stoppedAt
      ? `Saved ${applied.length} edit(s), then ${stoppedAt.tool} failed. Do not retry the saved edits.`
      : `Applied ${applied.length} edit(s).`;
    return {
      data: { sequenceId: input.sequenceId, applied, stoppedAt },
      summary,
    };
  },
});
