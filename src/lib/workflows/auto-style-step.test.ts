/**
 * `deriveAutoStyle` (#1213): one LLM call → write the recipe onto the bound
 * style row, re-snapshot the sequence from it, announce it. A row that lost
 * its binding mid-run (promoted) is never rewritten.
 */
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { AutoStyleResponse } from '@/lib/style/auto-style';
import type { WorkflowStep } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

const durableLLMCallCf = vi.fn();
vi.doMock('@/lib/workflows/llm-call-helper', () => ({ durableLLMCallCf }));

const emit = vi.fn();
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

const { deriveAutoStyle } = await import('./auto-style-step');

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: the step only uses `do`
const step = {
  do: async <T>(_name: string, fn: () => Promise<T>) => fn(),
} as unknown as WorkflowStep;

const RESPONSE: AutoStyleResponse = {
  name: 'Rain-slick Neon Noir',
  description: 'Wet streets and neon.',
  category: 'film',
  tags: ['noir'],
  mood: 'tense and paranoid',
  artStyle: 'high-contrast photorealism',
  medium: '',
  lighting: 'practical neon, hard shadows',
  colorPalette: ['#0a0a14', '#e8322f'],
  colorGrading: 'crushed blacks',
  camera: 'slow dollies',
  shots: '',
  pace: 'measured',
  energy: 2,
  references: ['neon-noir cityscapes'],
};

function makeScopedDb(bound: boolean, stillSelected = true) {
  const setGeneratedForSequence = vi.fn(async () => bound);
  const snapshotAutoStyle = vi.fn(async () => stillSelected);
  const stub = {
    styles: { setGeneratedForSequence },
    sequences: { snapshotAutoStyle },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the two writes the step performs
  const scopedDb = stub as unknown as WorkflowScopedDb;
  return { scopedDb, setGeneratedForSequence, snapshotAutoStyle };
}

const PARAMS = {
  workflowRunId: 'run-1',
  sequenceId: 'seq_1',
  styleId: 'style_auto',
  script: 'INT. HALLWAY — NIGHT',
  aspectRatio: '16:9' as const,
  analysisModelId: 'anthropic/claude-sonnet-5' as const,
};

describe('deriveAutoStyle', () => {
  it('writes the derived recipe to the bound row, re-snapshots the sequence, and emits', async () => {
    durableLLMCallCf.mockResolvedValueOnce(RESPONSE);
    emit.mockReset();
    const { scopedDb, setGeneratedForSequence, snapshotAutoStyle } =
      makeScopedDb(true);

    const config = await deriveAutoStyle(step, { scopedDb, ...PARAMS });

    expect(config.look.mood).toBe('tense and paranoid');
    expect(setGeneratedForSequence).toHaveBeenCalledWith({
      styleId: 'style_auto',
      sequenceId: 'seq_1',
      draft: expect.objectContaining({
        name: 'Rain-slick Neon Noir',
        category: 'film',
        config,
      }),
    });
    expect(snapshotAutoStyle).toHaveBeenCalledWith({
      id: 'seq_1',
      styleId: 'style_auto',
    });
    expect(emit).toHaveBeenCalledWith('generation.style:ready', {
      styleId: 'style_auto',
      name: 'Rain-slick Neon Noir',
    });
    const [, callConfig] = durableLLMCallCf.mock.calls[0] ?? [];
    expect(callConfig).toMatchObject({
      name: 'automatic-style',
      promptName: 'phase/automatic-style-chat',
      modelId: 'anthropic/claude-sonnet-5',
      promptVariables: {
        script: 'INT. HALLWAY — NIGHT',
        categories: expect.stringContaining('film, commercial'),
        paces: expect.stringContaining('slow, measured'),
      },
    });
  });

  it('saves a collapsed look/motion prose answer instead of failing the run (#1304)', async () => {
    durableLLMCallCf.mockImplementationOnce(
      async (_step: unknown, cfg: { responseSchema: z.ZodType }) =>
        cfg.responseSchema.parse({
          name: 'Bioluminescent Lab Noir',
          description: 'Dark cinematic science-explainer.',
          look: 'Photoreal CGI-meets-scientific-visualization in near-black negative space.',
          motion:
            'Slow, deliberate, gravity-free camera work on macro subjects.',
          colorPalette: ['#05080f', '#2fe3d6'],
          references: ['self-illuminated molecular structures'],
          category: 'tech',
          tags: ['science'],
          energy: 2,
          pace: 'measured',
        })
    );
    emit.mockReset();
    const { scopedDb, setGeneratedForSequence } = makeScopedDb(true);

    const config = await deriveAutoStyle(step, { scopedDb, ...PARAMS });

    expect(config.look.mood).toContain(
      'Photoreal CGI-meets-scientific-visualization'
    );
    expect(config.motion.camera).toContain('Slow, deliberate, gravity-free');
    expect(setGeneratedForSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ name: 'Bioluminescent Lab Noir' }),
      })
    );
  });

  it('saves an off-vocabulary category guess as film instead of failing the run (#1285)', async () => {
    // durableLLMCallCf parses through `responseSchema` — mirror that here.
    durableLLMCallCf.mockImplementationOnce(
      async (_step: unknown, cfg: { responseSchema: z.ZodType }) =>
        cfg.responseSchema.parse({ ...RESPONSE, category: 'documentary' })
    );
    emit.mockReset();
    const { scopedDb, setGeneratedForSequence } = makeScopedDb(true);

    await deriveAutoStyle(step, { scopedDb, ...PARAMS });

    expect(setGeneratedForSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ category: 'film' }),
      })
    );
  });

  it('refuses to touch a row that is no longer bound to the sequence', async () => {
    durableLLMCallCf.mockResolvedValueOnce(RESPONSE);
    emit.mockReset();
    const { scopedDb, snapshotAutoStyle } = makeScopedDb(false);

    await expect(
      deriveAutoStyle(step, { scopedDb, ...PARAMS })
    ).rejects.toThrow(/no longer bound/);
    expect(snapshotAutoStyle).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps a library style picked mid-run, still returning the derived config', async () => {
    durableLLMCallCf.mockResolvedValueOnce(RESPONSE);
    emit.mockReset();
    const { scopedDb, setGeneratedForSequence } = makeScopedDb(true, false);

    const config = await deriveAutoStyle(step, { scopedDb, ...PARAMS });

    expect(config.look.mood).toBe('tense and paranoid');
    expect(setGeneratedForSequence).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'generation.style:ready',
      expect.objectContaining({ styleId: 'style_auto' })
    );
  });

  it('fails non-retryably on an unsalvageable answer without writing anything', async () => {
    durableLLMCallCf.mockResolvedValueOnce({ ...RESPONSE, colorPalette: [] });
    emit.mockReset();
    const { scopedDb, setGeneratedForSequence } = makeScopedDb(true);

    await expect(
      deriveAutoStyle(step, { scopedDb, ...PARAMS })
    ).rejects.toThrow(/unsalvageable/);
    expect(setGeneratedForSequence).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
