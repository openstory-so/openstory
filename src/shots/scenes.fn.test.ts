import { describe, expect, it, vi } from 'vitest';
import { ValidationError, NotFoundError } from '@/platform/errors';

// Bypass middleware dependency chain for unit testing handler directly
vi.doMock('@/platform/middleware.fn', () => ({
  sequenceAccessMiddleware: {},
}));

// Expose the handler so these tests exercise the real handler logic
vi.doMock('@tanstack/react-start', async () => ({
  ...(await vi.importActual('@tanstack/react-start')),
  createServerFn: () => ({
    middleware() {
      return this;
    },
    validator() {
      return this;
    },
    handler(handler: unknown) {
      return handler;
    },
  }),
}));

const { updateSceneScriptFn } = await import('./scenes.fn');

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- createServerFn mock exposes the handler
const updateSceneScript = updateSceneScriptFn as unknown as (input: {
  data: { sequenceId: string; sceneId: string; extract: string };
  context: {
    user: { id: string };
    sequence: { id: string };
    scopedDb: {
      scenes: {
        getById: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
      sceneScriptVersions: {
        getSelected: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
    };
  };
}) => Promise<{ sceneId: string; script: unknown }>;

describe('updateSceneScriptFn', () => {
  it('throws ValidationError when scene has no script to edit', async () => {
    const sceneId = '01JABCD0000000000000000001';
    const sequenceId = '01JABCD0000000000000000000';

    const context = {
      user: { id: 'user-1' },
      sequence: { id: sequenceId },
      scopedDb: {
        scenes: {
          getById: vi.fn(async () => ({
            id: sceneId,
            sequenceId,
            continuity: null,
          })),
          update: vi.fn(async () => {}),
        },
        sceneScriptVersions: {
          getSelected: vi.fn(async () => null),
          write: vi.fn(async () => {}),
        },
      },
    };

    const promise = updateSceneScript({
      data: { sequenceId, sceneId, extract: 'New script extract' },
      context,
    });

    await expect(promise).rejects.toThrow(ValidationError);
    await expect(promise).rejects.toThrow('Scene has no script to edit');

    try {
      await updateSceneScript({
        data: { sequenceId, sceneId, extract: 'New script extract' },
        context,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const valErr = err as ValidationError;
      expect(valErr.code).toBe('VALIDATION_ERROR');
      expect(valErr.statusCode).toBe(400);
      expect(valErr.message).toBe('Scene has no script to edit');
    }

    expect(context.scopedDb.sceneScriptVersions.write).not.toHaveBeenCalled();
  });

  it('updates the script when a script already exists', async () => {
    const sceneId = '01JABCD0000000000000000001';
    const sequenceId = '01JABCD0000000000000000000';

    const existingContent = {
      extract: 'Original script extract',
      dialogue: [{ character: 'Hero', line: 'Hello', tone: '' }],
    };

    let selectedVersion = { content: existingContent };

    const context = {
      user: { id: 'user-1' },
      sequence: { id: sequenceId },
      scopedDb: {
        scenes: {
          getById: vi.fn(async () => ({
            id: sceneId,
            sequenceId,
            continuity: null,
          })),
          update: vi.fn(async () => {}),
        },
        sceneScriptVersions: {
          getSelected: vi.fn(async () => selectedVersion),
          write: vi.fn(async (args: { content: typeof existingContent }) => {
            selectedVersion = { content: args.content };
          }),
        },
      },
    };

    const result = await updateSceneScript({
      data: { sequenceId, sceneId, extract: 'Updated script extract' },
      context,
    });

    expect(result.sceneId).toBe(sceneId);
    expect(result.script).toEqual({
      extract: 'Updated script extract',
      dialogue: existingContent.dialogue,
    });
    expect(context.scopedDb.sceneScriptVersions.write).toHaveBeenCalledWith({
      sceneId,
      content: {
        extract: 'Updated script extract',
        dialogue: existingContent.dialogue,
      },
      source: 'edit',
      createdBy: 'user-1',
    });
  });

  it('throws NotFoundError when scene is not found in sequence', async () => {
    const sceneId = '01JABCD0000000000000000001';
    const sequenceId = '01JABCD0000000000000000000';

    const context = {
      user: { id: 'user-1' },
      sequence: { id: sequenceId },
      scopedDb: {
        scenes: {
          getById: vi.fn(async () => null),
          update: vi.fn(async () => {}),
        },
        sceneScriptVersions: {
          getSelected: vi.fn(async () => null),
          write: vi.fn(async () => {}),
        },
      },
    };

    await expect(
      updateSceneScript({
        data: { sequenceId, sceneId, extract: 'New script extract' },
        context,
      })
    ).rejects.toThrow(NotFoundError);
  });
});
