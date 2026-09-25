import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from './scene-analysis.schema';
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
  it.each(['First script', ''])(
    'creates the first version for a scene without a script (%j)',
    async (extract) => {
      getSelected.mockResolvedValue(null);
      const result = await updateScript({
        data: { ...data, extract },
        context,
      });
      expect(write).toHaveBeenCalledWith({
        sceneId: data.sceneId,
        content: { extract, dialogue: [] },
        source: 'edit',
        createdBy: 'user-1',
      });
      expect(result).toEqual({
        sceneId: data.sceneId,
        script: { extract, dialogue: [] },
      });
    }
  );

  it('preserves dialogue when editing an existing script', async () => {
    const dialogue = [{ character: 'Ada', line: 'Hello', tone: 'warm' }];
    getSelected.mockResolvedValue({
      content: { extract: 'Original', dialogue },
    });
    await updateScript({ data, context });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { extract: data.extract, dialogue },
      })
    );
  });

  it('does not create a version when an existing script is unchanged', async () => {
    getSelected.mockResolvedValue({
      content: { extract: data.extract, dialogue: [] },
    });
    await updateScript({ data, context });
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
