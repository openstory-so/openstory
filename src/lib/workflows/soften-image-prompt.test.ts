/**
 * Image content-rejection reseeds + one softened prompt retry (#1272).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import type { ImageGenerationResult } from '@/lib/image/image-generation';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowStep } from 'cloudflare:workers';

const generateImageWithProvider = vi.fn();
vi.doMock('@/lib/image/image-generation', async () => {
  const real = await vi.importActual<
    typeof import('@/lib/image/image-generation')
  >('@/lib/image/image-generation');
  return { ...real, generateImageWithProvider };
});

const durableLLMCallCf = vi.fn();
vi.doMock('@/lib/workflows/llm-call-helper', () => ({ durableLLMCallCf }));

const emit = vi.fn();
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

const { generateImageWithContentRetry, persistSoftenedPromptVersion } =
  await import('./soften-image-prompt');
const { NonRetryableError } = await import('cloudflare:workflows');

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only uses `do`
const step = {
  do: async <T>(_name: string, fn: () => Promise<T>) => fn(),
} as unknown as WorkflowStep;

const PARAMS: ImageGenerationParams = {
  model: 'nano_banana_2',
  prompt: 'A graphic fight in the alley',
  imageSize: 'landscape_16_9',
  numImages: 1,
};

function okResult(prompt = PARAMS.prompt): ImageGenerationResult {
  return {
    imageUrls: ['https://cdn/img.jpg'],
    parameters: { ...PARAMS, prompt },
    generatedAt: '2026-08-25T00:00:00.000Z',
    processingTimeMs: 12,
    via: 'fal',
    metadata: {
      prompt,
      model: PARAMS.model,
      endpointId: 'fal-ai/nano-banana-2',
      dimensions: [],
      file_sizes: [],
      usedOwnKey: false,
    },
  };
}

function contentError(message = 'material flagged by a content checker.') {
  return new Error(message);
}

function makeInput(
  overrides: Partial<ImageWorkflowInput> = {}
): ImageWorkflowInput {
  return {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'seq_1',
    shotId: 'shot-1',
    frameId: 'frame-1',
    prompt: 'A graphic fight in the alley',
    promptVersionId: 'fpv-1',
    model: 'nano_banana_2',
    ...overrides,
  };
}

function makeScopedDb() {
  const write = vi.fn(async (input: { text: string }) => ({
    id: 'fpv-soft',
    text: input.text,
    source: 'softened',
  }));
  const update = vi.fn(async () => ({ id: 'var-1' }));
  const appendVersion = vi.fn(async () => ({ id: 'var-grok' }));
  const setPendingPromoteVersionId = vi.fn(async () => undefined);
  const getByIdForFrame = vi.fn(async () => ({
    id: 'fpv-1',
    inputHash: 'hash-1',
    analysisModel: 'anthropic/claude-haiku-4.5',
  }));
  const stub = {
    framePromptVersions: { write },
    frameVariants: { update, appendVersion },
    frames: { setPendingPromoteVersionId },
    claims: { framePromptVersions: { getByIdForFrame } },
    credentials: {},
  };
  return {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub of the soften-path surface
    scopedDb: stub as unknown as WorkflowScopedDb,
    write,
    update,
    appendVersion,
    setPendingPromoteVersionId,
    getByIdForFrame,
  };
}

const BASE_ARGS = {
  step,
  workflowRunId: 'run-1',
  params: PARAMS,
  versionId: 'var-1',
  snapshotInputHash: 'snap-original',
};

describe('generateImageWithContentRetry', () => {
  beforeEach(() => {
    generateImageWithProvider.mockReset();
    durableLLMCallCf.mockReset();
    emit.mockReset();
  });

  it('returns the first successful generate without rewriting the prompt', async () => {
    generateImageWithProvider.mockResolvedValueOnce(okResult());
    const { scopedDb, write } = makeScopedDb();

    const out = await generateImageWithContentRetry({
      ...BASE_ARGS,
      scopedDb,
      input: makeInput(),
    });

    expect(generateImageWithProvider).toHaveBeenCalledTimes(1);
    expect(durableLLMCallCf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(out.prompt).toBe('A graphic fight in the alley');
    expect(out.snapshotInputHash).toBe('snap-original');
    expect(out.versionId).toBe('var-1');
    expect(out.result.imageUrls[0]).toBe('https://cdn/img.jpg');
  });

  it('reseeds the same prompt on a content rejection and skips soften when a later attempt lands', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockResolvedValueOnce(okResult());
    const { scopedDb, write } = makeScopedDb();

    const out = await generateImageWithContentRetry({
      ...BASE_ARGS,
      scopedDb,
      input: makeInput(),
    });

    expect(generateImageWithProvider).toHaveBeenCalledTimes(2);
    expect(durableLLMCallCf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(out.prompt).toBe('A graphic fight in the alley');
  });

  it('falls back to Grok Imagine 2 on the original prompt after reseeds exhaust', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockResolvedValueOnce(okResult());
    const {
      scopedDb,
      write,
      update,
      appendVersion,
      setPendingPromoteVersionId,
    } = makeScopedDb();

    const out = await generateImageWithContentRetry({
      ...BASE_ARGS,
      scopedDb,
      input: makeInput(),
    });

    expect(generateImageWithProvider).toHaveBeenCalledTimes(4);
    expect(durableLLMCallCf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('var-1', {
      status: 'failed',
      error: 'material flagged by a content checker.',
    });
    expect(appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: 'frame-1',
        sequenceId: 'seq_1',
        kind: 'model',
        model: 'grok_imagine_image',
        status: 'generating',
        workflowRunId: 'run-1',
      })
    );
    expect(setPendingPromoteVersionId).toHaveBeenCalledWith(
      'frame-1',
      'var-grok'
    );
    expect(emit).toHaveBeenCalledWith(
      'generation.image:progress',
      expect.objectContaining({
        shotId: 'shot-1',
        modelFallback: true,
        model: 'grok_imagine_image',
      })
    );
    expect(generateImageWithProvider.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({ model: 'grok_imagine_image' })
    );
    expect(out.versionId).toBe('var-grok');
    expect(out.params.model).toBe('grok_imagine_image');
    expect(out.prompt).toBe('A graphic fight in the alley');
  });

  it('does not steal primary promote when the original run was variant-only', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockResolvedValueOnce(okResult());
    const { scopedDb, appendVersion, setPendingPromoteVersionId } =
      makeScopedDb();

    await generateImageWithContentRetry({
      ...BASE_ARGS,
      scopedDb,
      input: makeInput({ variantOnly: true }),
    });

    expect(appendVersion).toHaveBeenCalled();
    expect(setPendingPromoteVersionId).not.toHaveBeenCalled();
  });

  it('softens and retries on Grok when the fallback also flags', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockResolvedValueOnce(
        okResult('Two figures confront each other in the alley')
      );
    durableLLMCallCf.mockResolvedValueOnce({
      prompt: 'Two figures confront each other in the alley',
    });
    const { scopedDb, write, update, getByIdForFrame } = makeScopedDb();

    const out = await generateImageWithContentRetry({
      ...BASE_ARGS,
      scopedDb,
      input: makeInput(),
    });

    expect(generateImageWithProvider).toHaveBeenCalledTimes(5);
    expect(durableLLMCallCf).toHaveBeenCalledTimes(1);
    const [, callConfig] = durableLLMCallCf.mock.calls[0] ?? [];
    expect(callConfig).toMatchObject({
      name: 'soften-image-prompt',
      promptName: 'phase/soften-image-prompt-chat',
      promptVariables: {
        prompt: 'A graphic fight in the alley',
        rejection: 'material flagged by a content checker.',
      },
    });
    expect(getByIdForFrame).toHaveBeenCalledWith('fpv-1', 'frame-1');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: 'frame-1',
        text: 'Two figures confront each other in the alley',
        source: 'softened',
        inputHash: 'hash-1',
        analysisModel: 'anthropic/claude-haiku-4.5',
        createdBy: 'u1',
      })
    );
    expect(update).toHaveBeenCalledWith('var-grok', {
      promptVersionId: 'fpv-soft',
    });
    expect(emit).toHaveBeenCalledWith(
      'generation.image:progress',
      expect.objectContaining({
        shotId: 'shot-1',
        promptSoftened: true,
        model: 'grok_imagine_image',
      })
    );
    expect(out.prompt).toBe('Two figures confront each other in the alley');
    expect(out.versionId).toBe('var-grok');
    expect(generateImageWithProvider.mock.calls[4]?.[0]).toEqual(
      expect.objectContaining({
        model: 'grok_imagine_image',
        prompt: 'Two figures confront each other in the alley',
      })
    );
  });

  it('skips the Grok swap when the selected model is already Grok Imagine 2', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockResolvedValueOnce(okResult('A tense alley standoff'));
    durableLLMCallCf.mockResolvedValueOnce({
      prompt: 'A tense alley standoff',
    });
    const grokParams: ImageGenerationParams = {
      ...PARAMS,
      model: 'grok_imagine_image',
    };
    const { scopedDb, appendVersion, write } = makeScopedDb();

    const out = await generateImageWithContentRetry({
      ...BASE_ARGS,
      params: grokParams,
      scopedDb,
      input: makeInput({ model: 'grok_imagine_image' }),
    });

    expect(appendVersion).not.toHaveBeenCalled();
    expect(generateImageWithProvider).toHaveBeenCalledTimes(4);
    expect(durableLLMCallCf).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalled();
    expect(out.versionId).toBe('var-1');
    expect(out.params.model).toBe('grok_imagine_image');
  });

  it('does not persist a prompt version for skipStorage previews', async () => {
    generateImageWithProvider
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockRejectedValueOnce(contentError())
      .mockResolvedValueOnce(okResult('A tense alley standoff'));
    durableLLMCallCf.mockResolvedValueOnce({
      prompt: 'A tense alley standoff',
    });
    const { scopedDb, write, appendVersion } = makeScopedDb();

    const out = await generateImageWithContentRetry({
      ...BASE_ARGS,
      scopedDb,
      input: makeInput({ skipStorage: true }),
    });

    expect(durableLLMCallCf).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(appendVersion).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(
      'generation.image:progress',
      expect.objectContaining({ promptSoftened: true })
    );
    expect(emit).not.toHaveBeenCalledWith(
      'generation.image:progress',
      expect.objectContaining({ modelFallback: true })
    );
    expect(out.prompt).toBe('A tense alley standoff');
    expect(out.params.model).toBe('grok_imagine_image');
  });

  it('fails non-retryably when the softened prompt is also rejected', async () => {
    generateImageWithProvider.mockRejectedValue(contentError());
    durableLLMCallCf.mockResolvedValueOnce({
      prompt: 'Two figures confront each other in the alley',
    });
    const { scopedDb } = makeScopedDb();

    await expect(
      generateImageWithContentRetry({
        ...BASE_ARGS,
        scopedDb,
        input: makeInput(),
      })
    ).rejects.toBeInstanceOf(NonRetryableError);

    expect(generateImageWithProvider).toHaveBeenCalledTimes(5);
  });

  it('fails with the original rejection when the rewrite is a no-op', async () => {
    generateImageWithProvider.mockRejectedValue(contentError());
    durableLLMCallCf.mockResolvedValueOnce({
      prompt: 'A graphic fight in the alley',
    });
    const { scopedDb, write } = makeScopedDb();

    await expect(
      generateImageWithContentRetry({
        ...BASE_ARGS,
        scopedDb,
        input: makeInput(),
      })
    ).rejects.toThrow(/content filter after 3 attempts/);
    expect(write).not.toHaveBeenCalled();
    expect(generateImageWithProvider).toHaveBeenCalledTimes(4);
  });

  it('rethrows non-content errors so CF can retry the generate step', async () => {
    generateImageWithProvider.mockRejectedValueOnce(
      new Error('503 Service Unavailable')
    );
    const { scopedDb } = makeScopedDb();

    await expect(
      generateImageWithContentRetry({
        ...BASE_ARGS,
        scopedDb,
        input: makeInput(),
      })
    ).rejects.toThrow('503 Service Unavailable');
    expect(durableLLMCallCf).not.toHaveBeenCalled();
  });
});

describe('persistSoftenedPromptVersion', () => {
  it('writes source softened and stamps the in-flight variant', async () => {
    const { scopedDb, write, update } = makeScopedDb();
    await persistSoftenedPromptVersion({
      scopedDb,
      frameId: 'frame-1',
      text: 'A tense alley standoff',
      provenance: {
        inputHash: 'hash-1',
        analysisModel: 'anthropic/claude-haiku-4.5',
      },
      versionId: 'var-1',
      createdBy: 'u1',
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'softened',
        text: 'A tense alley standoff',
        inputHash: 'hash-1',
      })
    );
    expect(update).toHaveBeenCalledWith('var-1', {
      promptVersionId: 'fpv-soft',
    });
  });
});
