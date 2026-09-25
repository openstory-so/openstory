import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from './scene-analysis.schema';
import {
  openStoryErrorSerializationAdapter,
  ValidationError,
} from '@/platform/errors';

const getById = vi.fn().mockResolvedValue({ sequenceId: 'sequence-1' });
const getSelected = vi.fn();
const write = vi.fn();
const context = {
  sequence: { id: 'sequence-1' },
  user: { id: 'user-1' },
  scopedDb: {
    scenes: { getById },
    sceneScriptVersions: { getSelected, write },
  },
};
type Handler = (args: {
  data: { sequenceId: string; sceneId: string; extract: string };
  context: typeof context;
}) => Promise<{ sceneId: string; script: Scene['originalScript'] }>;
const registerHandler = vi.fn<(handler: Handler) => Handler>(
  (handler) => handler
);
vi.doMock('@tanstack/react-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start')>()),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: registerHandler,
    };
    return builder;
  },
}));
vi.doMock('@/platform/middleware.fn', () => ({ sequenceAccessMiddleware: {} }));
await import('./scenes.fn');
// getScenes, getComposedScript, then updateSceneScript.
const updateScript = registerHandler.mock.calls[2]?.[0];
if (!updateScript) throw new Error('Scene script handler was not registered');
const data = {
  sequenceId: 'sequence-1',
  sceneId: 'scene-1',
  extract: 'Edited',
};

beforeEach(() => {
  getSelected.mockReset();
  write.mockClear();
});

describe('updateSceneScriptFn', () => {
  it('rejects a missing selected script with a serializable validation error and no write', async () => {
    getSelected.mockResolvedValue(null);
    const error = await updateScript({ data, context }).catch(
      (error: Error) => error
    );
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError))
      throw new Error('Expected validation error');
    const restored = openStoryErrorSerializationAdapter.fromSerializable(
      openStoryErrorSerializationAdapter.toSerializable(error)
    );
    expect(restored).toMatchObject({
      message: 'Scene has no script to edit',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('allows editing an existing script whose extract is empty', async () => {
    const content = { extract: '', dialogue: [] };
    getSelected.mockResolvedValue({ content });
    await updateScript({ data, context });
    expect(write).toHaveBeenCalledWith({
      sceneId: data.sceneId,
      content: { ...content, extract: 'Edited' },
      source: 'edit',
      createdBy: 'user-1',
    });
  });
});
