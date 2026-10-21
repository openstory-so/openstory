/**
 * One write for every non-generating sequence edit.
 * Hosts ask permission per tool name; this runs the individual edit tools
 * in order so a scene, shot, prompt, cast and music change is one approval.
 * Its input schema is the catalog: one variant per edit, with that edit's
 * arguments and description. Built after the other tools register.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  openstoryTool,
  registeredWriteCatalog,
  runRegisteredWrite,
} from '../tool-context';

function textOf(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === 'text');
  return block && 'text' in block ? block.text : 'Edit failed.';
}

/**
 * The edit's own arguments, without the sequenceId this call already has.
 * Rebuilt from the shape because some edits add a refinement, and Zod refuses
 * `.omit()` on those. The refinement still runs when the edit is applied.
 */
function withoutSequenceId(schema: z.ZodObject): z.ZodType {
  if (!Object.prototype.hasOwnProperty.call(schema.shape, 'sequenceId')) {
    return schema;
  }
  const { sequenceId: _sequenceId, ...rest } = schema.shape;
  return z.strictObject(rest);
}

export function createApplySequenceEdits() {
  const edits = registeredWriteCatalog();
  const variants = edits.map((edit) =>
    z.strictObject({
      tool: z.literal(edit.name),
      arguments: withoutSequenceId(edit.inputSchema)
        .optional()
        .describe(edit.description),
    })
  );
  const [first, ...rest] = variants;
  if (!first) throw new Error('No sequence edits are registered');
  const catalog = edits
    .map((edit) => `- ${edit.name}: ${edit.description}`)
    .join('\n');

  return openstoryTool({
    name: 'apply_sequence_edits',
    description:
      'Apply one or more sequence edits in a single call (one permission). ' +
      'Each change picks a tool by name and sends that tool’s arguments, except sequenceId, which is taken from this call. ' +
      'The change schema lists every allowed tool and its fields. ' +
      'A change that does not match the catalog is rejected before anything is written. ' +
      'A change that matches and then fails stops the batch; earlier changes are already saved, so do not retry those. ' +
      'Does not generate or spend credits — use the generate_* tools for that.\n\n' +
      catalog,
    scope: 'sequences:write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z.strictObject({
      sequenceId: ulidSchema,
      changes: z
        .array(z.discriminatedUnion('tool', [first, ...rest]))
        .min(1)
        .max(20),
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
        const rawArgs = change.arguments;
        const args: Record<string, unknown> =
          rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};
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
        const result = await run(
          { ...args, sequenceId: input.sequenceId },
          ctx
        );
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
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...raw }
            : {};
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
}
