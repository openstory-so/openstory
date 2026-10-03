import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { asStub } from '@/test/as-stub';
import {
  coerceScalars,
  openstoryTool,
  type ReadToolContext,
} from './tool-context';

const schema = z.object({
  count: z.number().optional(),
  flag: z.boolean().default(false),
  confirm: z.literal(true),
  duration: z.union([z.number().positive(), z.literal('auto')]).optional(),
  title: z.string().optional(),
  replaceWritten: z
    .strictObject({ visual: z.boolean(), motion: z.boolean() })
    .default({ visual: false, motion: false }),
});

describe('coerceScalars', () => {
  it('turns numeric and boolean strings into what the schema asks for', () => {
    expect(
      coerceScalars(schema, { count: ' 3 ', flag: 'false', confirm: 'true' })
    ).toEqual({ count: 3, flag: false, confirm: true });
  });

  it('turns a numeric string into a number inside a union', () => {
    expect(coerceScalars(schema, { duration: '5' })).toEqual({ duration: 5 });
  });

  it('keeps a string the schema already accepts', () => {
    expect(coerceScalars(schema, { duration: 'auto', title: '42' })).toEqual({
      duration: 'auto',
      title: '42',
    });
  });

  it('leaves values the schema would still reject for zod to report', () => {
    expect(
      coerceScalars(schema, { confirm: 'false', duration: '-2', count: 'x' })
    ).toEqual({ confirm: 'false', duration: '-2', count: 'x' });
  });

  it('coerces the scalars of an object field', () => {
    expect(
      coerceScalars(schema, {
        replaceWritten: { visual: 'true', motion: 'false' },
      })
    ).toEqual({ replaceWritten: { visual: true, motion: false } });
  });
});

const resultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

async function run(
  spec: Parameters<typeof openstoryTool>[0],
  input: Record<string, unknown>
) {
  const tool = openstoryTool(spec);
  if (!tool.execute) throw new Error('tool has no execute');
  return resultSchema.parse(
    await tool.execute(
      input,
      asStub({ context: { scoped: () => asStub<ReadToolContext>({}) } })
    )
  );
}

describe('runTool', () => {
  const base = {
    name: 'probe',
    scope: 'sequences:write' as const,
    annotations: writeAnnotations,
    description: 'probe',
    inputSchema: z.strictObject({ id: z.string() }),
    outputSchema: z.object({ id: z.string() }),
  };

  it('maps a zod parse, before or inside run, to VALIDATION_ERROR', async () => {
    const tool = {
      ...base,
      run: async () => {
        z.object({ parentId: z.string() }).parse({});
        return { data: { id: 'x' }, summary: 'ran' };
      },
    };
    expect(await run(tool, {})).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(await run(tool, { id: 'a' })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('reports a write whose result fails its schema as done, with the data', async () => {
    const result = await run(
      {
        ...base,
        run: async () => ({
          data: { id: 7, sceneId: 'scene_1', shotIds: ['s1'] },
          summary: 'ran',
        }),
      },
      { id: 'a' }
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'RESULT_NOT_RETURNED',
          details: { ids: { sceneId: 'scene_1', shotIds: ['s1'] } },
        },
      },
    });
    expect(result.content[0]?.text).toContain('Do not call it again');
    expect(result.content[0]?.text).not.toMatch(/retry/i);
    expect(result.content[1]?.text).toBe(
      JSON.stringify({ id: 7, sceneId: 'scene_1', shotIds: ['s1'] })
    );
  });

  it('keeps the ids of a write over the cap and never asks for a retry', async () => {
    const result = await run(
      {
        ...base,
        outputSchema: z.object({ id: z.string(), blob: z.string() }),
        run: async () => ({
          data: { id: 'a', blob: 'x'.repeat(300 * 1024) },
          summary: 'ran',
        }),
      },
      { id: 'a' }
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'RESULT_NOT_RETURNED', details: { ids: { id: 'a' } } },
      },
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).not.toMatch(/retry/i);
  });

  it('still asks a read over the cap to page', async () => {
    const result = await run(
      {
        ...base,
        annotations: { ...writeAnnotations, readOnlyHint: true },
        outputSchema: z.object({ id: z.string(), blob: z.string() }),
        run: async () => ({
          data: { id: 'a', blob: 'x'.repeat(300 * 1024) },
          summary: 'ran',
        }),
      },
      { id: 'a' }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Retry the collection');
  });
});
